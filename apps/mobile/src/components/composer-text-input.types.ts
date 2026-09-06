import type { TextInputProps } from 'react-native';

import type { LocalAttachmentFile } from '@/lib/attachments';

export interface ComposerTextInputProps extends TextInputProps {
  onPasteFiles?: (files: LocalAttachmentFile[]) => void;
  onPasteError?: (message: string) => void;
}
