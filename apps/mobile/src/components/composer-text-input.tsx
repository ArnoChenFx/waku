import { TextInput } from 'react-native';

import type { ComposerTextInputProps } from './composer-text-input.types';

export function ComposerTextInput({
  onPasteError: _onPasteError,
  onPasteFiles: _onPasteFiles,
  ...props
}: ComposerTextInputProps) {
  return <TextInput {...props} />;
}
