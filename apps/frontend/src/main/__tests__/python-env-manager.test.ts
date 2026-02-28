import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock child_process module before importing the module under test
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
    spawn: vi.fn(),
    execFile: vi.fn(),
  };
});

// Mock fs module before importing the module under test
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    access: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// Mock platform utilities - dynamically check process.platform
vi.mock('../platform', () => ({
  isLinux: vi.fn(() => process.platform === 'linux'),
  isWindows: vi.fn(() => process.platform === 'win32'),
  isMacOS: vi.fn(() => process.platform === 'darwin'),
  getPathDelimiter: vi.fn(() => process.platform === 'win32' ? ';' : ':'),
  findExecutable: vi.fn(),
}));

// Mock electron's app module
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getAppPath: vi.fn().mockReturnValue('/mock/app'),
    on: vi.fn(),
  },
}));

// Mock python-detector
vi.mock('../python-detector', () => ({
  findPythonCommand: vi.fn().mockReturnValue('python'),
  getBundledPythonPath: vi.fn().mockReturnValue(null),
}));

// Import after mocking
import { PythonEnvManager } from '../python-env-manager';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { isLinux, isWindows } from '../platform';

describe('PythonEnvManager', () => {
  let manager: PythonEnvManager;

  beforeEach(() => {
    manager = new PythonEnvManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getPythonEnv', () => {
    it('should return basic Python environment variables', () => {
      const env = manager.getPythonEnv();

      expect(env.PYTHONDONTWRITEBYTECODE).toBe('1');
      expect(env.PYTHONIOENCODING).toBe('utf-8');
      expect(env.PYTHONNOUSERSITE).toBe('1');
    });

    it('should exclude PYTHONHOME from environment', () => {
      // Use vi.stubEnv for cleaner environment variable mocking
      vi.stubEnv('PYTHONHOME', '/some/python/home');

      const env = manager.getPythonEnv();
      expect(env.PYTHONHOME).toBeUndefined();

      vi.unstubAllEnvs();
    });

    it('should preserve external PYTHONSTARTUP values', () => {
      // We no longer strip PYTHONSTARTUP - it passes through from the environment.
      // Note: PYTHONSTARTUP only runs in interactive Python mode (python REPL),
      // not when running scripts, so it doesn't affect our Python invocations.
      vi.stubEnv('PYTHONSTARTUP', '/some/external/startup.py');

      try {
        const env = manager.getPythonEnv();
        // External PYTHONSTARTUP should pass through unchanged
        expect(env.PYTHONSTARTUP).toBe('/some/external/startup.py');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('Windows pywin32 DLL loading fix', () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      // Mock Windows platform
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should add pywin32_system32 to PATH on Windows when sitePackagesPath is set', () => {
      const sitePackagesPath = 'C:\\test\\site-packages';

      // Access private property for testing
      (manager as unknown as { sitePackagesPath: string }).sitePackagesPath = sitePackagesPath;

      const env = manager.getPythonEnv();

      // Should include pywin32_system32 in PATH
      const expectedPath = path.join(sitePackagesPath, 'pywin32_system32');
      expect(env.PATH).toContain(expectedPath);
    });

    it('should include win32 and win32/lib in PYTHONPATH on Windows', () => {
      const sitePackagesPath = 'C:\\test\\site-packages';

      // Access private property for testing
      (manager as unknown as { sitePackagesPath: string }).sitePackagesPath = sitePackagesPath;

      const env = manager.getPythonEnv();

      // PYTHONPATH should include site-packages, win32, and win32/lib
      expect(env.PYTHONPATH).toContain(sitePackagesPath);
      expect(env.PYTHONPATH).toContain(path.join(sitePackagesPath, 'win32'));
      expect(env.PYTHONPATH).toContain(
        path.join(sitePackagesPath, 'win32', 'lib')
      );
    });

    it('should not add Windows-specific PATH modification on non-Windows platforms', () => {
      // Restore non-Windows platform
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const sitePackagesPath = '/test/site-packages';

      // Access private property for testing
      (manager as unknown as { sitePackagesPath: string }).sitePackagesPath = sitePackagesPath;

      const env = manager.getPythonEnv();

      // PYTHONPATH should just be the site-packages (no win32 additions)
      expect(env.PYTHONPATH).toBe(sitePackagesPath);

      // PATH should not contain pywin32_system32
      expect(env.PATH || '').not.toContain('pywin32_system32');
    });

    it('should normalize PATH case sensitivity on Windows', () => {
      // On Windows, env vars are case-insensitive but Node.js preserves case.
      // If the environment has 'Path' (lowercase t), we should normalize to 'PATH'
      // to avoid issues with Node.js lexicographic sorting.
      // See: https://github.com/nodejs/node/issues/9157
      const sitePackagesPath = 'C:\\test\\site-packages';

      // Access private property for testing
      (manager as unknown as { sitePackagesPath: string }).sitePackagesPath = sitePackagesPath;

      // Save and clear existing PATH, then set lowercase 'Path'
      // This simulates a Windows environment where the system has 'Path' instead of 'PATH'
      const originalPath = process.env.PATH;
      delete process.env.PATH;
      process.env.Path = 'C:\\Windows\\System32';

      try {
        const env = manager.getPythonEnv();

        // Should have a PATH key (uppercase) containing both pywin32_system32 and original Path value
        expect(env.PATH).toBeDefined();
        expect(env.PATH).toContain('pywin32_system32');
        expect(env.PATH).toContain('C:\\Windows\\System32');

        // Should NOT have both 'PATH' and 'Path' keys (case normalization)
        // The lowercase 'Path' should be removed to avoid Node.js case-sensitivity issues
        const pathKeys = Object.keys(env).filter(k => k.toUpperCase() === 'PATH');
        expect(pathKeys.length).toBe(1);
        expect(pathKeys[0]).toBe('PATH');
      } finally {
        // Restore original PATH
        delete process.env.Path;
        if (originalPath !== undefined) {
          process.env.PATH = originalPath;
        }
      }
    });
  });

  describe('PythonEnvManager - New Functionality (Spec 003)', () => {
    describe('validateVenvModule', () => {
      it('should return valid when venv module exists', () => {
        // Mock execSync to succeed
        vi.mocked(execSync).mockReturnValue('');

        const result = (manager as any)['validateVenvModule']('/usr/bin/python3');

        expect(result.valid).toBe(true);
        expect(result.message).toContain('venv module is available');
      });

      it('should return error with Linux package hint when venv missing on Linux', () => {
        // Mock execSync to throw (venv not found)
        vi.mocked(execSync).mockImplementation(() => {
          throw new Error('No module named venv');
        });
        vi.mocked(isLinux).mockReturnValue(true);

        const result = (manager as any)['validateVenvModule']('/usr/bin/python3');

        expect(result.valid).toBe(false);
        expect(result.message).toContain("'venv' module not found");
        expect(result.message).toContain('sudo apt install python3-venv');
        expect(result.message).toContain('sudo dnf install python3-venv');
      });

      it('should return error with download link on non-Linux when venv missing', () => {
        vi.mocked(execSync).mockImplementation(() => {
          throw new Error('No module named venv');
        });
        vi.mocked(isLinux).mockReturnValue(false);

        const result = (manager as any)['validateVenvModule']('/path/to/python');

        expect(result.valid).toBe(false);
        expect(result.message).toContain("'venv' module not found");
        expect(result.message).toContain('https://www.python.org/downloads/');
      });
    });

    describe('validateVenvWritePermissions', () => {
      it('should return valid when directory is writable', async () => {
        // Mock fs.access to succeed (no error)
        vi.mocked(fs.access).mockImplementation((path: any, mode: any, callback: any) => {
          callback(null);
        });
        vi.mocked(fs.existsSync).mockReturnValue(true);

        const result = await (manager as any)['validateVenvWritePermissions']('/writable/path');

        expect(result.valid).toBe(true);
        expect(result.message).toContain('writable');
      });

      it('should return error when directory not writable', async () => {
        vi.mocked(fs.access).mockImplementation((path: any, mode: any, callback: any) => {
          callback(new Error('EACCES: permission denied'));
        });
        vi.mocked(fs.existsSync).mockReturnValue(true);

        const result = await (manager as any)['validateVenvWritePermissions']('/readonly/path');

        expect(result.valid).toBe(false);
        expect(result.message).toContain('not writable');
      });

      it('should include chmod hint on Linux when not writable', async () => {
        vi.mocked(fs.access).mockImplementation((path: any, mode: any, callback: any) => {
          callback(new Error('EACCES'));
        });
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(isLinux).mockReturnValue(true);

        const result = await (manager as any)['validateVenvWritePermissions']('/readonly/path');

        expect(result.valid).toBe(false);
        expect(result.message).toContain('chmod u+w');
      });

      it('should include Windows hint when not writable on Windows', async () => {
        vi.mocked(fs.access).mockImplementation((path: any, mode: any, callback: any) => {
          callback(new Error('EACCES'));
        });
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(isLinux).mockReturnValue(false);
        vi.mocked(isWindows).mockReturnValue(true);

        const result = await (manager as any)['validateVenvWritePermissions']('/readonly/path');

        expect(result.valid).toBe(false);
        expect(result.message).toContain('Properties > Security');
      });

      it('should create parent directories if they do not exist', async () => {
        // First call to existsSync for venvPath returns false (doesn't exist)
        // Second call to existsSync for dirToCheck (parent) returns false
        // After mkdirSync, we check permissions
        let existsCallCount = 0;
        vi.mocked(fs.existsSync).mockImplementation(() => {
          existsCallCount++;
          return existsCallCount > 2; // Return false for first two calls, true after
        });

        vi.mocked(fs.mkdirSync).mockImplementation(() => {});
        vi.mocked(fs.access).mockImplementation((path: any, mode: any, callback: any) => {
          callback(null); // Writable
        });

        const result = await (manager as any)['validateVenvWritePermissions']('/new/path/venv');

        expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
        expect(result.valid).toBe(true);
      });

      it('should return error when directory creation fails', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.mkdirSync).mockImplementation(() => {
          throw new Error('Permission denied');
        });

        const result = await (manager as any)['validateVenvWritePermissions']('/protected/path');

        expect(result.valid).toBe(false);
        expect(result.message).toContain('Cannot create directory');
        expect(result.message).toContain('Permission denied');
      });
    });

    describe('retryWithBackoff', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should retry 3 times with exponential backoff delays', async () => {
        let attempts = 0;
        const operation = vi.fn(async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Transient failure');
          }
          return 'success';
        });

        // Mock getVenvBasePath to return null (so cleanupPartialVenv doesn't run)
        vi.spyOn(manager as any, 'getVenvBasePath').mockReturnValue(null);

        const promise = (manager as any)['retryWithBackoff'](operation, 3, 1000);

        // Fast-forward through delays
        await vi.advanceTimersByTimeAsync(1000); // First retry after 1s
        await vi.advanceTimersByTimeAsync(2000); // Second retry after 2s

        const result = await promise;

        expect(attempts).toBe(3);
        expect(result).toBe('success');
      });

      it('should clean up partial venv before each retry', async () => {
        const cleanupSpy = vi.spyOn(manager as any, 'cleanupPartialVenv').mockImplementation(() => {});
        vi.spyOn(manager as any, 'getVenvBasePath').mockReturnValue('/test/venv');

        const operation = vi.fn(async () => {
          throw new Error('Always fails');
        });

        const promise = (manager as any)['retryWithBackoff'](operation, 3, 100);

        // IMPORTANT: Set up expectation BEFORE advancing timers
        const expectation = expect(promise).rejects.toThrow('Always fails');

        // Advance timers for each retry
        await vi.advanceTimersByTimeAsync(100); // First retry after 100ms
        await vi.advanceTimersByTimeAsync(200); // Second retry after 200ms

        // Wait for expectation to complete
        await expectation;

        // Should call cleanup 2 times (before retry 2 and retry 3)
        expect(cleanupSpy).toHaveBeenCalledTimes(2);
      });

      it('should throw error after max retries exhausted', async () => {
        vi.spyOn(manager as any, 'getVenvBasePath').mockReturnValue(null);

        const operation = vi.fn(async () => {
          throw new Error('Persistent failure');
        });

        const promise = (manager as any)['retryWithBackoff'](operation, 3, 100);

        // IMPORTANT: Set up expectation BEFORE advancing timers
        const expectation = expect(promise).rejects.toThrow('Persistent failure');

        // Advance timers for each retry
        await vi.advanceTimersByTimeAsync(100); // First retry after 100ms
        await vi.advanceTimersByTimeAsync(200); // Second retry after 200ms

        // Wait for expectation to complete
        await expectation;

        expect(operation).toHaveBeenCalledTimes(3);
      });

      it('should succeed immediately if operation succeeds on first try', async () => {
        const operation = vi.fn(async () => 'success');

        const result = await (manager as any)['retryWithBackoff'](operation, 3, 1000);

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(1);
      });

      it('should use correct exponential backoff delays', async () => {
        const delays: number[] = [];
        let attempts = 0;

        const operation = vi.fn(async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Fail');
          }
          return 'success';
        });

        vi.spyOn(manager as any, 'getVenvBasePath').mockReturnValue(null);

        // Track setTimeout calls to verify delays
        const originalSetTimeout = global.setTimeout;
        vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number) => {
          if (typeof delay === 'number' && delay > 0) {
            delays.push(delay);
          }
          return originalSetTimeout(callback, delay);
        }) as any);

        const promise = (manager as any)['retryWithBackoff'](operation, 3, 1000);

        await vi.advanceTimersByTimeAsync(1000); // 1s
        await vi.advanceTimersByTimeAsync(2000); // 2s

        await promise;

        // Verify exponential backoff: 1000 * 2^0 = 1000, 1000 * 2^1 = 2000
        expect(delays).toEqual([1000, 2000]);
      });
    });

    describe('cleanupPartialVenv', () => {
      it('should remove existing venv directory', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.rmSync).mockImplementation(() => {});

        (manager as any)['cleanupPartialVenv']('/path/to/venv');

        expect(fs.rmSync).toHaveBeenCalledWith('/path/to/venv', {
          recursive: true,
          force: true
        });
      });

      it('should not error when venv directory does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        expect(() => {
          (manager as any)['cleanupPartialVenv']('/path/to/venv');
        }).not.toThrow();
      });

      it('should not throw if rmSync fails', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.rmSync).mockImplementation(() => {
          throw new Error('Permission denied');
        });

        // Should not throw - errors are logged but not propagated
        expect(() => {
          (manager as any)['cleanupPartialVenv']('/path/to/venv');
        }).not.toThrow();
      });
    });
  });
});
