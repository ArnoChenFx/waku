import { describe, expect, test } from 'bun:test';
import type { WakuClient } from '@waku/client';

import {
  importLocalAttachment,
  localFileName,
  MAX_ATTACHMENT_BYTES,
} from './attachments';

describe('mobile attachments', () => {
  test('imports local data through the daemon and retains display metadata', async () => {
    const commands: unknown[] = [];
    const client = {
      request: async (command: unknown) => {
        commands.push(command);
        return {
          type: 'attachmentStored',
          attachment: {
            reference: 'waku-attachment:file',
            path: '/daemon/blobs/photo.png',
            name: 'photo.png',
            isDir: false,
          },
        };
      },
    } as unknown as WakuClient;

    const attachment = await importLocalAttachment(client, {
      uri: 'file:///photo.png',
      name: 'photo.png',
      mimeType: 'image/png',
      size: 3,
      base64: 'data:image/png;base64,YWJj',
    });

    expect(commands).toEqual([{
      type: 'importAttachment',
      name: 'photo.png',
      upload: { kind: 'file', data_base64: 'YWJj' },
    }]);
    expect(attachment).toEqual({
      path: '/daemon/blobs/photo.png',
      mention: '/daemon/blobs/photo.png',
      name: 'photo.png',
      is_dir: false,
      is_image: true,
      blob_reference: 'waku-attachment:file',
    });
  });

  test('rejects an oversized file before reading or uploading it', async () => {
    const client = { request: () => Promise.reject(new Error('should not upload')) } as unknown as WakuClient;
    await expect(importLocalAttachment(client, {
      uri: 'file:///large.zip',
      name: 'large.zip',
      size: MAX_ATTACHMENT_BYTES + 1,
    })).rejects.toThrow('32 MB maximum');
  });

  test('derives a decoded name from a picker URI', () => {
    expect(localFileName('file:///tmp/Camera%20Photo.jpg?edited=1', 'photo.jpg'))
      .toBe('Camera Photo.jpg');
  });
});
