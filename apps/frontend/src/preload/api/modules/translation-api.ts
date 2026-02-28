import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  TranslationRequest,
  TranslationResponse,
  TargetLanguage,
  TranslatableContentType,
  IPCResult,
} from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/**
 * Translation API operations for AI-generated content
 */
export interface TranslationAPI {
  // Translation Operations
  translateContent: (request: TranslationRequest) => Promise<IPCResult<TranslationResponse>>;
  revertTranslation: (
    projectId: string,
    contentType: TranslatableContentType,
    contentId: string
  ) => Promise<IPCResult<void>>;
  getAvailableTranslations: (
    projectId: string,
    contentType: TranslatableContentType,
    contentId: string
  ) => Promise<IPCResult<TargetLanguage[]>>;
  clearTranslations: (
    projectId: string,
    contentType: TranslatableContentType,
    contentId: string
  ) => Promise<IPCResult<void>>;
}

/**
 * Creates the Translation API implementation
 */
export const createTranslationAPI = (): TranslationAPI => ({
  translateContent: (request: TranslationRequest): Promise<IPCResult<TranslationResponse>> =>
    invokeIpc(IPC_CHANNELS.TRANSLATION_TRANSLATE, request),

  revertTranslation: (
    projectId: string,
    contentType: TranslatableContentType,
    contentId: string
  ): Promise<IPCResult<void>> =>
    invokeIpc(IPC_CHANNELS.TRANSLATION_REVERT, projectId, contentType, contentId),

  getAvailableTranslations: (
    projectId: string,
    contentType: TranslatableContentType,
    contentId: string
  ): Promise<IPCResult<TargetLanguage[]>> =>
    invokeIpc(IPC_CHANNELS.TRANSLATION_GET_AVAILABLE, projectId, contentType, contentId),

  clearTranslations: (
    projectId: string,
    contentType: TranslatableContentType,
    contentId: string
  ): Promise<IPCResult<void>> =>
    invokeIpc(IPC_CHANNELS.TRANSLATION_CLEAR, projectId, contentType, contentId),
});
