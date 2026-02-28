/**
 * Translation-related types for AI-generated content translation system
 */

// ============================================
// Language Types
// ============================================

/**
 * Supported target languages for translation
 * - pt-BR: Portuguese (Brazil)
 * - es: Spanish
 * - de: German
 * - fr: French
 */
export type TargetLanguage = 'pt-BR' | 'es' | 'de' | 'fr';

/**
 * All supported languages including source language
 */
export type SupportedLanguage = 'en' | TargetLanguage;

/**
 * Language display information
 */
export interface LanguageInfo {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
}

// ============================================
// Content Types
// ============================================

/**
 * Types of AI-generated content that can be translated
 */
export type TranslatableContentType = 'roadmap' | 'idea' | 'changelog' | 'spec';

/**
 * Unique identifier for translatable content
 */
export interface ContentIdentifier {
  type: TranslatableContentType;
  id: string; // Content-specific ID (e.g., feature ID, idea ID, spec ID)
}

// ============================================
// Translation Request/Response Types
// ============================================

/**
 * Request to translate content to a target language
 */
export interface TranslationRequest {
  contentType: TranslatableContentType;
  contentId: string;
  content: Record<string, unknown>; // Original content structure (JSON)
  targetLanguage: TargetLanguage;
  projectId?: string; // Optional project context
}

/**
 * Response from translation service
 */
export interface TranslationResponse {
  contentType: TranslatableContentType;
  contentId: string;
  originalContent: Record<string, unknown>;
  translatedContent: Record<string, unknown>;
  language: TargetLanguage;
  metadata: TranslationMetadata;
}

/**
 * Metadata about a translation operation
 */
export interface TranslationMetadata {
  language: TargetLanguage;
  timestamp: Date;
  model: string; // Claude model used (e.g., "claude-sonnet-4-5")
  contentHash: string; // SHA256 hash of original content for cache validation
  tokensUsed?: number; // API tokens consumed
  cached?: boolean; // Whether result came from cache
}

// ============================================
// Cache Types
// ============================================

/**
 * Cached translation entry stored in file system
 * Path: .auto-claude/translations/{content_type}/{content_id}/{language}.json
 */
export interface TranslationCacheEntry {
  originalContent: Record<string, unknown>;
  translatedContent: Record<string, unknown>;
  metadata: TranslationMetadata;
}

/**
 * Cache validation result
 */
export interface CacheValidationResult {
  valid: boolean;
  reason?: 'miss' | 'expired' | 'hash_mismatch' | 'corrupted';
}

// ============================================
// Translation State Types (for Zustand store)
// ============================================

/**
 * Translation state for a specific piece of content
 */
export interface ContentTranslationState {
  contentId: string;
  contentType: TranslatableContentType;
  currentLanguage: SupportedLanguage; // Current display language
  originalLanguage: 'en';
  availableTranslations: Set<TargetLanguage>; // Languages that have been translated
  translating: boolean; // Currently translating
  error?: string;
}

/**
 * Map of content translations indexed by unique key
 * Key format: "{contentType}:{contentId}"
 */
export type TranslationStateMap = Map<string, ContentTranslationState>;

/**
 * Stored translation data indexed by language
 * Key format: "{contentType}:{contentId}:{language}"
 */
export type TranslationDataMap = Map<string, Record<string, unknown>>;

// ============================================
// Translation Operation Types
// ============================================

/**
 * Status of a translation operation
 */
export type TranslationStatus = 'idle' | 'translating' | 'success' | 'error' | 'rate_limited';

/**
 * Progress information for translation operations
 */
export interface TranslationProgress {
  status: TranslationStatus;
  message?: string;
  progress?: number; // 0-100 for batch operations
  error?: string;
  retryIn?: number; // Seconds until retry (for rate limiting)
}

/**
 * Options for translation operations
 */
export interface TranslationOptions {
  forceRefresh?: boolean; // Skip cache and force new translation
  priority?: 'high' | 'normal' | 'low'; // Queue priority
}

// ============================================
// Error Types
// ============================================

/**
 * Translation error codes
 */
export type TranslationErrorCode =
  | 'RATE_LIMITED' // API rate limit exceeded
  | 'NETWORK_ERROR' // Connection failure
  | 'AUTH_ERROR' // Authentication failure
  | 'INVALID_CONTENT' // Malformed content structure
  | 'UNSUPPORTED_LANGUAGE' // Language not supported
  | 'TRANSLATION_FAILED' // Generic translation failure
  | 'CACHE_ERROR'; // Cache read/write error

/**
 * Structured translation error
 */
export interface TranslationError {
  code: TranslationErrorCode;
  message: string;
  details?: string;
  retryable: boolean;
  retryAfter?: number; // Seconds (for RATE_LIMITED)
}

// ============================================
// IPC Types
// ============================================

/**
 * IPC request to translate content
 */
export interface TranslateContentIPC {
  request: TranslationRequest;
  options?: TranslationOptions;
}

/**
 * IPC response for translation request
 */
export interface TranslateContentIPCResult {
  success: boolean;
  data?: TranslationResponse;
  error?: TranslationError;
}

/**
 * IPC request to revert translation (restore original language)
 */
export interface RevertTranslationIPC {
  contentType: TranslatableContentType;
  contentId: string;
}

/**
 * IPC request to check available translations for content
 */
export interface GetAvailableTranslationsIPC {
  contentType: TranslatableContentType;
  contentId: string;
}

/**
 * IPC response for available translations
 */
export interface AvailableTranslationsResult {
  languages: TargetLanguage[];
  cached: Record<TargetLanguage, boolean>; // Which languages are cached
}

// ============================================
// Utility Types
// ============================================

/**
 * Helper to generate unique key for translation maps
 */
export type TranslationKey = `${TranslatableContentType}:${string}`;

/**
 * Helper to generate cache key including language
 */
export type TranslationCacheKey = `${TranslatableContentType}:${string}:${TargetLanguage}`;

/**
 * Translation statistics for monitoring/debugging
 */
export interface TranslationStats {
  totalTranslations: number;
  cacheHits: number;
  cacheMisses: number;
  errors: number;
  avgResponseTime: number; // milliseconds
  byLanguage: Record<TargetLanguage, number>;
  byContentType: Record<TranslatableContentType, number>;
}
