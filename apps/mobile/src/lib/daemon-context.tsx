import { useQueryClient } from "@tanstack/react-query";
import { WakuClient, type WebSocketLike } from "@waku/client";
import * as Crypto from "expo-crypto";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";

import { daemonKeys } from "./daemon-api";
import { hydratePersistentStorage } from "./composer-preferences-store";
import {
  normalizeDaemonProfile,
  isPrivateDaemonAddress,
  type DaemonProfile,
  type DaemonProfileInput,
} from "./daemon-profile";
import {
  deleteDaemonToken,
  readActiveDaemonId,
  readDaemonProfiles,
  readDaemonToken,
  writeActiveDaemonId,
  writeDaemonProfiles,
  writeDaemonToken,
} from "./daemon-storage";

export type ConnectionPhase =
  "booting" | "disconnected" | "connecting" | "connected" | "error";

interface DaemonContextValue {
  profiles: DaemonProfile[];
  activeProfile: DaemonProfile | null;
  client: WakuClient | null;
  phase: ConnectionPhase;
  error: string | null;
  saveProfile: (
    input: DaemonProfileInput,
    id?: string,
  ) => Promise<{
    profile: DaemonProfile;
    connected: boolean;
  }>;
  selectProfile: (id: string) => Promise<boolean>;
  removeProfile: (id: string) => Promise<void>;
  reconnect: () => Promise<boolean>;
  disconnect: () => void;
}

const DaemonContext = createContext<DaemonContextValue | null>(null);

function createNativeDaemonSocket(url: string): WebSocketLike {
  // React Native adds an Origin header to native sockets. This marker lets the
  // daemon distinguish them from browser WebSockets, whose API cannot add
  // custom handshake headers. The DOM constructor type omits RN's third arg.
  const NativeWebSocket = WebSocket as unknown as {
    new (
      url: string,
      protocols: string | string[] | null,
      options: { headers: Record<string, string> },
    ): WebSocketLike;
  };
  return new NativeWebSocket(url, null, {
    headers: { "X-Waku-Client": "native" },
  });
}

export function DaemonProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [profiles, setProfiles] = useState<DaemonProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [client, setClient] = useState<WakuClient | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>("booting");
  const [error, setError] = useState<string | null>(null);
  const profilesRef = useRef<DaemonProfile[]>([]);
  const activeProfileIdRef = useRef<string | null>(null);
  const clientRef = useRef<WakuClient | null>(null);
  const phaseRef = useRef<ConnectionPhase>("booting");
  const generation = useRef(0);
  const reconnectAttempt = useRef(0);
  const bootstrapped = useRef(false);
  const unsubscribeConnection = useRef<(() => void) | null>(null);
  const unsubscribeTaskState = useRef<(() => void) | null>(null);

  const updatePhase = useCallback((next: ConnectionPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const commitProfiles = useCallback(async (next: DaemonProfile[]) => {
    profilesRef.current = next;
    setProfiles(next);
    await writeDaemonProfiles(next);
  }, []);

  const closeCurrentClient = useCallback((updateReactState = true) => {
    unsubscribeConnection.current?.();
    unsubscribeConnection.current = null;
    unsubscribeTaskState.current?.();
    unsubscribeTaskState.current = null;
    const current = clientRef.current;
    clientRef.current = null;
    if (updateReactState) setClient(null);
    current?.disconnect();
  }, []);

  const activate = useCallback(
    async (
      profileId: string,
      candidates = profilesRef.current,
    ): Promise<boolean> => {
      const profile = candidates.find((item) => item.id === profileId);
      if (!profile) return false;

      const attempt = ++generation.current;
      closeCurrentClient();
      activeProfileIdRef.current = profile.id;
      setActiveProfileId(profile.id);
      updatePhase("connecting");
      setError(null);

      try {
        await writeActiveDaemonId(profile.id);
      } catch (cause) {
        if (generation.current !== attempt) return false;
        setError(errorMessage(cause, "Couldn’t remember the selected daemon"));
        updatePhase("error");
        return false;
      }

      let token: string | null;
      try {
        token = await readDaemonToken(profile.id);
      } catch (cause) {
        if (generation.current !== attempt) return false;
        setError(errorMessage(cause, "Couldn’t read this daemon token"));
        updatePhase("error");
        return false;
      }
      if (generation.current !== attempt) return false;
      if (!token) {
        setError(
          "This daemon token is missing. Edit the connection to add it again.",
        );
        updatePhase("error");
        return false;
      }

      const next = new WakuClient({
        address: profile.address,
        token,
        randomUUID: Crypto.randomUUID,
        webSocketFactory:
          Platform.OS === "web" ? undefined : createNativeDaemonSocket,
      });
      let connectedOnce = false;
      clientRef.current = next;
      setClient(next);
      unsubscribeConnection.current = next.subscribeConnectionState((state) => {
        if (generation.current !== attempt || clientRef.current !== next)
          return;
        if (state === "connecting") {
          updatePhase("connecting");
          return;
        }
        if (state === "connected") {
          connectedOnce = true;
          setError(null);
          updatePhase("connected");
          return;
        }
        if (connectedOnce) {
          setError(
            "The daemon connection closed. Your tasks are still safe on the host.",
          );
          updatePhase("error");
        }
      });

      try {
        await next.connect();
        if (generation.current !== attempt || clientRef.current !== next) {
          next.disconnect();
          return false;
        }
        unsubscribeTaskState.current = next.subscribeTaskState(() => {
          void queryClient.invalidateQueries({
            queryKey: daemonKeys.taskState(profile.id),
          });
        });
        const connectedAt = Date.now();
        const updated = profilesRef.current.map((item) =>
          item.id === profile.id
            ? { ...item, lastConnectedAt: connectedAt }
            : item,
        );
        profilesRef.current = updated;
        setProfiles(updated);
        void writeDaemonProfiles(updated).catch(() => {
          // A recency metadata write must not turn a live connection into an error state.
        });
        return true;
      } catch (cause) {
        if (generation.current !== attempt || clientRef.current !== next)
          return false;
        setError(errorMessage(cause, "Couldn’t connect to this daemon"));
        updatePhase("error");
        return false;
      }
    },
    [closeCurrentClient, commitProfiles, queryClient, updatePhase],
  );

  const reconnect = useCallback(async (): Promise<boolean> => {
    const id = activeProfileIdRef.current;
    const current = clientRef.current;
    if (!id) return false;
    if (!current) return activate(id);
    if (current.connectionState === "connected") {
      setError(null);
      updatePhase("connected");
      return true;
    }
    if (current.connectionState === "connecting") return false;

    const attempt = generation.current;
    setError(null);
    updatePhase("connecting");
    try {
      await current.connect();
      return generation.current === attempt && clientRef.current === current;
    } catch (cause) {
      if (generation.current !== attempt || clientRef.current !== current)
        return false;
      setError(errorMessage(cause, "Couldn’t reconnect to this daemon"));
      updatePhase("error");
      return false;
    }
  }, [activate, updatePhase]);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void hydratePersistentStorage();
    void (async () => {
      try {
        const [savedProfiles, savedActiveId] = await Promise.all([
          readDaemonProfiles(),
          readActiveDaemonId(),
        ]);
        profilesRef.current = savedProfiles;
        setProfiles(savedProfiles);
        if (!savedProfiles.length) {
          updatePhase("disconnected");
          return;
        }
        const selected = savedProfiles.some((item) => item.id === savedActiveId)
          ? savedActiveId!
          : savedProfiles[0]!.id;
        await activate(selected, savedProfiles);
      } catch (cause) {
        setError(errorMessage(cause, "Couldn’t load saved daemons"));
        updatePhase("error");
      }
    })();
  }, [activate, updatePhase]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const id = activeProfileIdRef.current;
      if (id && phaseRef.current === "error") void reconnect();
    });
    return () => subscription.remove();
  }, [reconnect]);

  // A dropped connection retries itself with capped exponential backoff while
  // the app is foregrounded. Every phase change reruns this effect, so a
  // failed attempt (error → connecting → error) schedules the next one and a
  // success resets the ladder.
  useEffect(() => {
    if (phase !== "error") {
      reconnectAttempt.current = 0;
      return;
    }
    if (AppState.currentState !== "active") return;
    const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt.current);
    const timer = setTimeout(() => {
      reconnectAttempt.current += 1;
      void reconnect();
    }, delay);
    return () => clearTimeout(timer);
  }, [phase, reconnect]);

  useEffect(
    () => () => {
      ++generation.current;
      closeCurrentClient(false);
    },
    [closeCurrentClient],
  );

  const saveProfile = useCallback(
    async (
      input: DaemonProfileInput,
      id?: string,
    ): Promise<{ profile: DaemonProfile; connected: boolean }> => {
      const existing = id
        ? profilesRef.current.find((item) => item.id === id)
        : undefined;
      if (id && !existing)
        throw new Error("This saved daemon no longer exists");
      const profile = normalizeDaemonProfile(
        input,
        existing,
        id ?? Crypto.randomUUID(),
      );
      if (
        profile.address.startsWith("ws://") &&
        !isPrivateDaemonAddress(profile.address)
      ) {
        throw new Error(
          "Use wss:// for a daemon outside your local or private network",
        );
      }
      const duplicate = profilesRef.current.find(
        (item) => item.id !== profile.id && item.address === profile.address,
      );
      if (duplicate)
        throw new Error(`${duplicate.name} already uses this daemon address`);

      const token = input.token?.trim();
      if (!existing && !token) throw new Error("Enter the daemon token");
      if (token) await writeDaemonToken(profile.id, token);
      else if (!(await readDaemonToken(profile.id)))
        throw new Error("Enter the daemon token");

      const next = existing
        ? profilesRef.current.map((item) =>
            item.id === profile.id ? profile : item,
          )
        : [profile, ...profilesRef.current];
      await commitProfiles(next);
      const connected = await activate(profile.id, next);
      return { profile, connected };
    },
    [activate, commitProfiles],
  );

  const selectProfile = useCallback((id: string) => activate(id), [activate]);

  const removeProfile = useCallback(
    async (id: string) => {
      const current = profilesRef.current;
      if (!current.some((item) => item.id === id)) return;
      const next = current.filter((item) => item.id !== id);
      const token = await readDaemonToken(id);
      await deleteDaemonToken(id);
      try {
        await commitProfiles(next);
      } catch (cause) {
        if (token) await writeDaemonToken(id, token);
        throw cause;
      }
      queryClient.removeQueries({ queryKey: ["daemon", id] });
      if (activeProfileIdRef.current !== id) return;

      ++generation.current;
      closeCurrentClient();
      activeProfileIdRef.current = null;
      setActiveProfileId(null);
      await writeActiveDaemonId(null);
      setError(null);
      if (next.length) await activate(next[0]!.id, next);
      else updatePhase("disconnected");
    },
    [activate, closeCurrentClient, commitProfiles, queryClient, updatePhase],
  );

  const disconnect = useCallback(() => {
    ++generation.current;
    closeCurrentClient();
    setError(null);
    updatePhase("disconnected");
  }, [closeCurrentClient, updatePhase]);

  const activeProfile =
    profiles.find((item) => item.id === activeProfileId) ?? null;
  return (
    <DaemonContext.Provider
      value={{
        profiles,
        activeProfile,
        client,
        phase,
        error,
        saveProfile,
        selectProfile,
        removeProfile,
        reconnect,
        disconnect,
      }}
    >
      {children}
    </DaemonContext.Provider>
  );
}

export function useDaemon() {
  const context = useContext(DaemonContext);
  if (!context) throw new Error("useDaemon must be used inside DaemonProvider");
  return context;
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return fallback;
}
