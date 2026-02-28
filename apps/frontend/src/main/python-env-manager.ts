import { spawn, execSync, ChildProcess } from 'child_process';
import { existsSync, readdirSync, access, constants, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { app } from 'electron';
import { findPythonCommand, getBundledPythonPath } from './python-detector';
import { isLinux, isWindows, getPathDelimiter } from './platform';
import { getIsolatedGitEnv } from './utils/git-isolation';
import { normalizeEnvPathKey } from './agent/env-utils';

export interface PythonEnvStatus {
  ready: boolean;
  pythonPath: string | null;
  sitePackagesPath: string | null;
  venvExists: boolean;
  depsInstalled: boolean;
  usingBundledPackages: boolean;
  error?: string;
}

/**
 * Manages the Python environment for the auto-claude backend.
 *
 * For packaged apps:
 *   - Uses bundled Python binary (resources/python/)
 *   - Uses bundled site-packages (resources/python-site-packages/)
 *   - No venv creation or pip install needed - everything is pre-bundled
 *
 * For development mode:
 *   - Creates venv in the source directory
 *   - Installs dependencies via pip
 *
 * On packaged apps (especially Linux AppImages), the bundled source is read-only,
 * so for dev mode fallback we create the venv in userData instead.
 */
export class PythonEnvManager extends EventEmitter {
  private autoBuildSourcePath: string | null = null;
  private pythonPath: string | null = null;
  private sitePackagesPath: string | null = null;
  private usingBundledPackages = false;
  private isInitializing = false;
  private isReady = false;
  private initializationPromise: Promise<PythonEnvStatus> | null = null;
  private activeProcesses: Set<ChildProcess> = new Set();
  private static readonly VENV_CREATION_TIMEOUT_MS = 120000; // 2 minutes timeout for venv creation

  /**
   * Get the path where the venv should be created.
   * For packaged apps, this is in userData to avoid read-only filesystem issues.
   * For development, this is inside the source directory.
   */
  private getVenvBasePath(): string | null {
    if (!this.autoBuildSourcePath) return null;

    // For packaged apps, put venv in userData (writable location)
    // This fixes Linux AppImage where resources are read-only
    if (app.isPackaged) {
      return path.join(app.getPath('userData'), 'python-venv');
    }

    // Development mode - use source directory
    return path.join(this.autoBuildSourcePath, '.venv');
  }

  /**
   * Get the path to the venv Python executable
   */
  private getVenvPythonPath(): string | null {
    const venvPath = this.getVenvBasePath();
    if (!venvPath) return null;

    const venvPython =
      isWindows()
        ? path.join(venvPath, 'Scripts', 'python.exe')
        : path.join(venvPath, 'bin', 'python');

    return venvPython;
  }

  /**
   * Get the path to pip in the venv
   * Returns null - we use python -m pip instead for better compatibility
   * @deprecated Use getVenvPythonPath() with -m pip instead
   */
  private getVenvPipPath(): string | null {
    return null; // Not used - we use python -m pip
  }

  /**
   * Check if venv exists
   */
  private venvExists(): boolean {
    const venvPython = this.getVenvPythonPath();
    return venvPython ? existsSync(venvPython) : false;
  }

  /**
   * Get the path to bundled site-packages (for packaged apps).
   * These are pre-installed during the build process.
   */
  private getBundledSitePackagesPath(): string | null {
    if (!app.isPackaged) {
      return null;
    }

    const sitePackagesPath = path.join(process.resourcesPath, 'python-site-packages');

    if (existsSync(sitePackagesPath)) {
      console.log(`[PythonEnvManager] Found bundled site-packages at: ${sitePackagesPath}`);
      return sitePackagesPath;
    }

    console.log(`[PythonEnvManager] Bundled site-packages not found at: ${sitePackagesPath}`);
    return null;
  }

  /**
   * Check if bundled packages are available and valid.
   * For packaged apps, we check if the bundled site-packages directory exists
   * and contains the marker file indicating successful bundling.
   */
  private hasBundledPackages(): boolean {
    const sitePackagesPath = this.getBundledSitePackagesPath();
    if (!sitePackagesPath) {
      return false;
    }

    // Critical packages that must exist for proper functionality
    // This fixes GitHub issue #416 where marker exists but packages are missing
    // Note: Same list exists in download-python.cjs - keep them in sync
    // This validation assumes traditional Python packages with __init__.py (not PEP 420 namespace packages)
    // pywin32 is platform-critical for Windows (ACS-306) - required by MCP library
    const platformCriticalPackages: Record<string, string[]> = {
      win32: ['pywintypes'] // Check for 'pywintypes' instead of 'pywin32' (pywin32 installs top-level modules)
    };
    // secretstorage is optional for Linux (ACS-310) - nice to have for keyring integration
    // but app falls back to .env file storage if missing, so don't block bundled packages
    const platformOptionalPackages: Record<string, string[]> = {
      linux: ['secretstorage'] // Linux OAuth token storage via Freedesktop.org Secret Service
    };

    const criticalPackages = [
      'claude_agent_sdk',
      'dotenv',
      'pydantic_core',
      ...(isWindows() ? platformCriticalPackages.win32 : [])
    ];
    const optionalPackages = isLinux() ? platformOptionalPackages.linux : [];

    // Check each package exists with valid structure (directory + __init__.py or single-file module)
    const packageExists = (pkg: string): boolean => {
      const pkgPath = path.join(sitePackagesPath, pkg);
      const initPath = path.join(pkgPath, '__init__.py');
      // For single-file modules (like pywintypes.py), check for the file directly
      const moduleFile = path.join(sitePackagesPath, `${pkg}.py`);
      // Package is valid if directory+__init__.py exists OR single-file module exists
      return (existsSync(pkgPath) && existsSync(initPath)) || existsSync(moduleFile);
    };

    const missingPackages = criticalPackages.filter((pkg) => !packageExists(pkg));
    const missingOptional = optionalPackages.filter((pkg) => !packageExists(pkg));

    // Log missing packages for debugging
    for (const pkg of missingPackages) {
      console.log(
        `[PythonEnvManager] Missing critical package: ${pkg} at ${path.join(sitePackagesPath, pkg)}`
      );
    }
    // Log warnings for missing optional packages (non-blocking)
    for (const pkg of missingOptional) {
      console.warn(
        `[PythonEnvManager] Optional package missing: ${pkg} at ${path.join(sitePackagesPath, pkg)}`
      );
    }

    // All critical packages must exist - don't rely solely on marker file
    if (missingPackages.length === 0) {
      // Also check marker for logging purposes
      const markerPath = path.join(sitePackagesPath, '.bundled');
      if (existsSync(markerPath)) {
        console.log(`[PythonEnvManager] Found bundle marker and all critical packages`);
      } else {
        console.log(`[PythonEnvManager] Found critical packages (marker missing)`);
      }
      return true;
    }

    return false;
  }

  /**
   * Check if required dependencies are installed.
   * Verifies all packages that must be present for the backend to work.
   * This ensures users don't encounter broken functionality when using features.
   */
  private async checkDepsInstalled(): Promise<boolean> {
    const venvPython = this.getVenvPythonPath();
    if (!venvPython || !existsSync(venvPython)) return false;

    try {
      // Check all dependencies - if any fail, we need to reinstall
      // This prevents issues where partial installs leave some packages missing
      // See: https://github.com/AndyMik90/Auto-Claude/issues/359
      //
      // Dependencies checked:
      // - claude_agent_sdk: Core agent SDK (required)
      // - dotenv: Environment variable loading (required)
      // - google.generativeai: Google AI/Gemini support (required for full functionality)
      // - real_ladybug + graphiti_core: Graphiti memory system (Python 3.12+ only)
      const checkScript = `
import sys
import claude_agent_sdk
import dotenv
import google.generativeai
# Graphiti dependencies only available on Python 3.12+
if sys.version_info >= (3, 12):
    import real_ladybug
    import graphiti_core
`;
      execSync(`"${venvPython}" -c "${checkScript.replace(/\n/g, '; ').replace(/; ; /g, '; ')}"`, {
        stdio: 'pipe',
        timeout: 15000,
        encoding: 'utf-8'
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find Python 3.10+ (bundled or system).
   * Uses the shared python-detector logic which validates version requirements.
   * Priority: bundled Python (packaged apps) > system Python
   */
  private findSystemPython(): string | null {
    const pythonCmd = findPythonCommand();
    if (!pythonCmd) {
      return null;
    }

    // If this is the bundled Python path, use it directly
    const bundledPath = getBundledPythonPath();
    if (bundledPath && pythonCmd === bundledPath) {
      console.log(`[PythonEnvManager] Using bundled Python: ${bundledPath}`);
      return bundledPath;
    }

    try {
      // Get the actual executable path from the command
      // For commands like "py -3", we need to resolve to the actual executable
      const pythonPath = execSync(`${pythonCmd} -c "import sys; print(sys.executable)"`, {
        stdio: 'pipe',
        timeout: 5000,
        encoding: 'utf-8'
      }).trim();

      console.log(`[PythonEnvManager] Found Python at: ${pythonPath}`);
      return pythonPath;
    } catch (err) {
      console.error(`[PythonEnvManager] Failed to get Python path for ${pythonCmd}:`, err);
      return null;
    }
  }

  /**
   * Validate that the venv module is available in the given Python installation.
   * The venv module is required to create virtual environments.
   *
   * @param pythonPath - The Python executable path to validate
   * @returns Validation result with status and error message
   */
  private validateVenvModule(pythonPath: string): {
    valid: boolean;
    message: string;
  } {
    try {
      // Check if venv module is available by running --help
      execSync(`"${pythonPath}" -m venv --help`, {
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true
      });

      console.log(`[PythonEnvManager] venv module validation passed for: ${pythonPath}`);
      return {
        valid: true,
        message: 'venv module is available'
      };
    } catch (error) {
      console.warn(`[PythonEnvManager] venv module not found in: ${pythonPath}`);

      // Provide platform-specific installation instructions
      let errorMsg = `Python virtual environment creation failed: 'venv' module not found.\n\n`;

      if (isLinux()) {
        errorMsg +=
          `On Debian/Ubuntu: sudo apt install python3-venv\n` +
          `On Fedora/RHEL: sudo dnf install python3-venv\n` +
          `On other systems: ensure Python 3.10+ is installed with venv support.`;
      } else {
        errorMsg +=
          `Ensure Python 3.10+ is installed with venv support.\n` +
          `Download from: https://www.python.org/downloads/\n\n` +
          `Note: The venv module is included with standard Python installations.`;
      }

      return {
        valid: false,
        message: errorMsg
      };
    }
  }

  /**
   * Validate write permissions for venv destination directory.
   * Checks if the parent directory (or the venv directory itself if it exists) is writable.
   *
   * @param venvPath - The path where the venv will be created
   * @returns Validation result with status and error message
   */
  private async validateVenvWritePermissions(venvPath: string): Promise<{
    valid: boolean;
    message: string;
  }> {
    try {
      // Determine which directory to check for write permissions
      const dirToCheck = existsSync(venvPath) ? venvPath : path.dirname(venvPath);

      // Ensure the parent directory exists before checking permissions
      if (!existsSync(dirToCheck)) {
        try {
          mkdirSync(dirToCheck, { recursive: true });
          console.log(`[PythonEnvManager] Created directory: ${dirToCheck}`);
        } catch (mkdirError) {
          const errorMsg =
            `Cannot create directory for Python virtual environment.\n\n` +
            `Path: ${dirToCheck}\n\n` +
            `Error: ${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}\n\n` +
            `Possible solutions:\n` +
            `- Ensure you have write permissions to the parent directory\n` +
            `- Try running the application with appropriate permissions\n` +
            (isLinux() ? `- On Linux: Check directory ownership with 'ls -la' and use 'chmod' if needed\n` : '') +
            (isWindows() ? `- On Windows: Check folder permissions in Properties > Security\n` : '');

          return {
            valid: false,
            message: errorMsg
          };
        }
      }

      // Check write permissions using fs.access with W_OK constant
      return new Promise((resolve) => {
        access(dirToCheck, constants.W_OK, (err) => {
          if (err) {
            const errorMsg =
              `Python virtual environment directory is not writable.\n\n` +
              `Path: ${dirToCheck}\n\n` +
              `Error: ${err.message}\n\n` +
              `Possible solutions:\n` +
              `- Ensure you have write permissions to this directory\n` +
              (isLinux()
                ? `- On Linux: Use 'chmod u+w "${dirToCheck}"' to add write permissions\n` +
                  `- Or choose a different directory in your home folder\n`
                : '') +
              (isWindows()
                ? `- On Windows: Right-click the folder > Properties > Security > Edit permissions\n` +
                  `- Or choose a different directory\n`
                : '') +
              `- Contact your system administrator if you're on a managed system`;

            console.error(
              `[PythonEnvManager] Write permission check failed for: ${dirToCheck}`,
              err
            );

            resolve({
              valid: false,
              message: errorMsg
            });
          } else {
            console.log(`[PythonEnvManager] Write permission validation passed for: ${dirToCheck}`);
            resolve({
              valid: true,
              message: 'Directory is writable'
            });
          }
        });
      });
    } catch (error) {
      console.error('[PythonEnvManager] Unexpected error during permission validation:', error);
      return {
        valid: false,
        message: `Failed to validate write permissions: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Clean up partial or corrupted venv directory.
   * This is called before retrying venv creation to ensure a clean slate.
   *
   * @param venvPath - The path to the venv directory to clean up
   */
  private cleanupPartialVenv(venvPath: string): void {
    try {
      if (existsSync(venvPath)) {
        console.warn(`[PythonEnvManager] Cleaning up partial venv at: ${venvPath}`);
        rmSync(venvPath, { recursive: true, force: true });
        console.warn(`[PythonEnvManager] Successfully cleaned up partial venv`);
      }
    } catch (error) {
      console.error(`[PythonEnvManager] Failed to clean up partial venv:`, error);
      // Don't throw - we'll let the retry attempt anyway
    }
  }

  /**
   * Retry wrapper with exponential backoff.
   * Retries an operation up to maxRetries times with exponentially increasing delays.
   * Cleans up partial venv before each retry attempt.
   *
   * @param operation - The async operation to retry
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param baseDelay - Base delay in milliseconds (default: 1000ms = 1s)
   * @returns The result of the operation
   * @throws The last error if all retries are exhausted
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        // If this is the last attempt, throw the error
        if (attempt === maxRetries - 1) {
          throw error;
        }

        // Calculate exponential backoff delay: 1s, 2s, 4s
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(
          `[PythonEnvManager] Attempt ${attempt + 1}/${maxRetries} failed. Retrying in ${delay}ms...`
        );

        // Clean up partial venv before retry
        const venvPath = this.getVenvBasePath();
        if (venvPath) {
          this.cleanupPartialVenv(venvPath);
        }

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // This should never be reached due to the throw in the loop, but TypeScript needs it
    throw new Error('Max retries exceeded');
  }

  /**
   * Create the virtual environment with retry logic and exponential backoff.
   * Retries up to 3 times with delays of 1s, 2s, 4s to handle transient failures.
   * Cleans up partial venv directories before each retry attempt.
   */
  private async createVenv(): Promise<boolean> {
    try {
      return await this.retryWithBackoff(
        () => this.createVenvInternal(),
        3, // maxRetries
        1000 // baseDelay (1s)
      );
    } catch (error) {
      // All retries exhausted - error has already been emitted by createVenvInternal
      console.error('[PythonEnvManager] Venv creation failed after all retries');
      return false;
    }
  }

  /**
   * Internal method to create the virtual environment (without retry logic).
   * This is wrapped by createVenv() which adds retry logic with exponential backoff.
   */
  private async createVenvInternal(): Promise<boolean> {
    if (!this.autoBuildSourcePath) return false;

    const systemPython = this.findSystemPython();
    if (!systemPython) {
      const isPackaged = app.isPackaged;
      const errorMsg = isPackaged
        ? 'Python not found. The bundled Python may be corrupted.\n\n' +
          'Please try reinstalling the application, or install Python 3.10+ manually:\n' +
          'https://www.python.org/downloads/'
        : 'Python 3.10+ not found. Please install Python 3.10 or higher.\n\n' +
          'This is required for development mode. Download from:\n' +
          'https://www.python.org/downloads/';
      this.emit('error', errorMsg);
      return false;
    }

    // Validate venv module is available before attempting to create venv
    const venvValidation = this.validateVenvModule(systemPython);
    if (!venvValidation.valid) {
      console.error('[PythonEnvManager] venv module validation failed:', venvValidation.message);
      this.emit('error', venvValidation.message);
      return false;
    }

    // Validate write permissions for venv destination directory
    const venvPath = this.getVenvBasePath()!;
    const permissionValidation = await this.validateVenvWritePermissions(venvPath);
    if (!permissionValidation.valid) {
      console.error(
        '[PythonEnvManager] Write permission validation failed:',
        permissionValidation.message
      );
      this.emit('error', permissionValidation.message);
      return false;
    }

    this.emit('status', 'Creating Python virtual environment...');
    console.warn('[PythonEnvManager] Creating venv at:', venvPath, 'with:', systemPython);

    return new Promise((resolve) => {
      const proc = spawn(systemPython, ['-m', 'venv', venvPath], {
        cwd: this.autoBuildSourcePath!,
        stdio: 'pipe',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });

      // Track the process for cleanup on app exit
      this.activeProcesses.add(proc);

      let stderr = '';
      let resolved = false;

      // Set up timeout to kill hung venv creation
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.error('[PythonEnvManager] Venv creation timed out after', PythonEnvManager.VENV_CREATION_TIMEOUT_MS, 'ms');

          const timeoutErrorMsg =
            `Python virtual environment creation timed out after ${PythonEnvManager.VENV_CREATION_TIMEOUT_MS / 1000} seconds.\n\n` +
            `This usually indicates:\n` +
            `- Slow disk I/O or insufficient disk space\n` +
            `- Antivirus software blocking Python operations\n` +
            `- System resource constraints (low memory or CPU)\n\n` +
            `Possible solutions:\n` +
            `- Ensure you have at least 500MB of free disk space\n` +
            `- Temporarily disable antivirus and try again\n` +
            (isWindows()
              ? `- Check Windows Defender exclusions for the application directory\n` +
                `- Run the application as administrator if you're on a restricted system\n`
              : '') +
            (isLinux()
              ? `- Check available disk space with 'df -h'\n` +
                `- Verify Python installation with 'python3 --version'\n`
              : '') +
            `- Restart the application and try again\n` +
            `- If the issue persists, check system logs for related errors`;

          this.emit('error', timeoutErrorMsg);
          try {
            proc.kill();
          } catch {
            // Process may already be dead
          }
          this.activeProcesses.delete(proc);
          resolve(false);
        }
      }, PythonEnvManager.VENV_CREATION_TIMEOUT_MS);

      proc.stderr?.on('data', (data) => {
        stderr += data.toString('utf-8');
      });

      proc.on('close', (code) => {
        if (resolved) return; // Already handled by timeout
        resolved = true;
        clearTimeout(timeoutId);
        this.activeProcesses.delete(proc);

        if (code === 0) {
          console.warn('[PythonEnvManager] Venv created successfully');
          resolve(true);
        } else {
          console.error('[PythonEnvManager] Failed to create venv:', stderr);

          const venvErrorMsg =
            `Failed to create Python virtual environment.\n\n` +
            `Error details: ${stderr || 'No error output available'}\n\n` +
            `Common causes and solutions:\n` +
            `- Python 'venv' module missing:\n` +
            (isLinux()
              ? `  • On Debian/Ubuntu: sudo apt install python3-venv\n` +
                `  • On Fedora/RHEL: sudo dnf install python3-venv\n`
              : `  • Reinstall Python 3.10+ from https://www.python.org/downloads/\n` +
                `  • Ensure you select "Add Python to PATH" during installation\n`) +
            `- Insufficient permissions:\n` +
            (isLinux()
              ? `  • Check directory permissions with 'ls -la'\n` +
                `  • Use 'chmod' to add write permissions if needed\n`
              : '') +
            (isWindows()
              ? `  • Run the application as administrator\n` +
                `  • Check folder permissions in Properties > Security\n`
              : '') +
            `- Disk space:\n` +
            `  • Ensure at least 500MB of free disk space is available\n` +
            `- Corrupted Python installation:\n` +
            `  • Try reinstalling Python 3.10 or higher`;

          this.emit('error', venvErrorMsg);
          resolve(false);
        }
      });

      proc.on('error', (err) => {
        if (resolved) return; // Already handled by timeout
        resolved = true;
        clearTimeout(timeoutId);
        this.activeProcesses.delete(proc);

        console.error('[PythonEnvManager] Error creating venv:', err);

        const processErrorMsg =
          `Failed to start Python virtual environment creation process.\n\n` +
          `Error: ${err.message}\n\n` +
          `This usually means:\n` +
          `- Python executable not found or not accessible\n` +
          `- Python installation is corrupted\n` +
          `- System security software is blocking Python execution\n\n` +
          `Recommended actions:\n` +
          `1. Verify Python installation:\n` +
          (isWindows()
            ? `   • Open Command Prompt and run: python --version\n` +
              `   • Should show Python 3.10 or higher\n`
            : `   • Open terminal and run: python3 --version\n` +
              `   • Should show Python 3.10 or higher\n`) +
          `2. Reinstall Python if version is incorrect or command not found:\n` +
          `   • Download from: https://www.python.org/downloads/\n` +
          (isWindows()
            ? `   • During installation, check "Add Python to PATH"\n`
            : '') +
          `3. Check antivirus/security software settings:\n` +
          `   • Add Python to the allowlist/exclusions\n` +
          `4. Restart the application after fixing Python installation`;

        this.emit('error', processErrorMsg);
        resolve(false);
      });
    });
  }

  /**
   * Bootstrap pip in the venv using ensurepip
   */
  private async bootstrapPip(): Promise<boolean> {
    const venvPython = this.getVenvPythonPath();
    if (!venvPython || !existsSync(venvPython)) {
      return false;
    }

    console.warn('[PythonEnvManager] Bootstrapping pip...');
    return new Promise((resolve) => {
      const proc = spawn(venvPython, ['-m', 'ensurepip'], {
        cwd: this.autoBuildSourcePath!,
        stdio: 'pipe',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });

      let stderr = '';
      proc.stderr?.on('data', (data) => {
        stderr += data.toString('utf-8');
      });

      proc.on('close', (code) => {
        if (code === 0) {
          console.warn('[PythonEnvManager] Pip bootstrapped successfully');
          resolve(true);
        } else {
          console.error('[PythonEnvManager] Failed to bootstrap pip:', stderr);
          resolve(false);
        }
      });

      proc.on('error', (err) => {
        console.error('[PythonEnvManager] Error bootstrapping pip:', err);
        resolve(false);
      });
    });
  }

  /**
   * Install dependencies from requirements.txt using python -m pip
   */
  private async installDeps(): Promise<boolean> {
    if (!this.autoBuildSourcePath) return false;

    const venvPython = this.getVenvPythonPath();
    const requirementsPath = path.join(this.autoBuildSourcePath, 'requirements.txt');

    if (!venvPython || !existsSync(venvPython)) {
      const pythonNotFoundMsg =
        `Python executable not found in virtual environment.\n\n` +
        `Expected location: ${venvPython || 'undefined'}\n\n` +
        `This indicates the virtual environment was not created successfully.\n\n` +
        `Possible solutions:\n` +
        `- Restart the application to recreate the virtual environment\n` +
        `- Delete the virtual environment directory and let the app recreate it:\n` +
        `  Directory: ${this.getVenvBasePath() || 'undefined'}\n` +
        `- Ensure Python 3.10+ is installed on your system\n` +
        `- Check available disk space (need at least 500MB)\n` +
        `- If the issue persists, reinstall the application`;

      this.emit('error', pythonNotFoundMsg);
      return false;
    }

    if (!existsSync(requirementsPath)) {
      const requirementsNotFoundMsg =
        `Python dependencies file not found.\n\n` +
        `Expected location: ${requirementsPath}\n\n` +
        `This indicates the application installation is incomplete or corrupted.\n\n` +
        `Required actions:\n` +
        `1. Verify application integrity:\n` +
        (app.isPackaged
          ? `   • Reinstall the application from the official download\n` +
            `   • Ensure the installation completed without errors\n`
          : `   • Check that apps/backend/requirements.txt exists in the project\n` +
            `   • Run 'git status' to verify repository integrity\n` +
            `   • Try 'git checkout apps/backend/requirements.txt' to restore the file\n`) +
        `2. If reinstalling doesn't help:\n` +
        `   • Check antivirus logs - it may have quarantined files\n` +
        `   • Temporarily disable antivirus and reinstall\n` +
        `3. Contact support if the issue persists`;

      this.emit('error', requirementsNotFoundMsg);
      return false;
    }

    // Bootstrap pip first if needed
    await this.bootstrapPip();

    this.emit('status', 'Installing Python dependencies (this may take a minute)...');
    console.warn('[PythonEnvManager] Installing dependencies from:', requirementsPath);

    return new Promise((resolve) => {
      // Use python -m pip for better compatibility across Python versions
      const proc = spawn(venvPython, ['-m', 'pip', 'install', '-r', requirementsPath], {
        cwd: this.autoBuildSourcePath!,
        stdio: 'pipe',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString('utf-8');
        // Emit progress updates for long-running installations
        const lines = data.toString('utf-8').split('\n');
        for (const line of lines) {
          if (line.includes('Installing') || line.includes('Successfully')) {
            this.emit('status', line.trim());
          }
        }
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString('utf-8');
      });

      proc.on('close', (code) => {
        if (code === 0) {
          console.warn('[PythonEnvManager] Dependencies installed successfully');
          this.emit('status', 'Dependencies installed successfully');
          resolve(true);
        } else {
          console.error('[PythonEnvManager] Failed to install deps:', stderr || stdout);

          // Parse common pip errors for better messaging
          const output = stderr || stdout || 'No error output available';
          const isNetworkError = output.includes('Could not fetch URL') ||
                                 output.includes('Network is unreachable') ||
                                 output.includes('Connection timeout');
          const isPermissionError = output.includes('Permission denied') ||
                                   output.includes('EACCES');
          const isDiskSpaceError = output.includes('No space left on device') ||
                                  output.includes('ENOSPC');

          let installErrorMsg = `Failed to install Python dependencies.\n\n`;

          if (isNetworkError) {
            installErrorMsg +=
              `Network connection issue detected.\n\n` +
              `Possible solutions:\n` +
              `- Check your internet connection\n` +
              `- Verify firewall settings allow Python/pip to access the internet\n` +
              `- Try using a different network (e.g., disable VPN if active)\n` +
              `- If behind a corporate proxy, configure pip proxy settings:\n` +
              `  pip config set global.proxy http://your-proxy:port\n` +
              `- Wait a few minutes and try again (PyPI may be temporarily down)\n\n`;
          } else if (isPermissionError) {
            installErrorMsg +=
              `Permission denied error detected.\n\n` +
              `Possible solutions:\n` +
              (isWindows()
                ? `- Run the application as administrator\n` +
                  `- Check folder permissions in Properties > Security\n`
                : `- Ensure you have write permissions to the virtual environment directory\n` +
                  `- Try: chmod -R u+w "${this.getVenvBasePath()}"\n`) +
              `- Antivirus software may be blocking the installation\n` +
              `- Restart the application and try again\n\n`;
          } else if (isDiskSpaceError) {
            installErrorMsg +=
              `Insufficient disk space.\n\n` +
              `Required actions:\n` +
              `- Free up at least 1GB of disk space\n` +
              (isWindows()
                ? `- Run Disk Cleanup (search in Start menu)\n`
                : `- Run: df -h to check available space\n`) +
              `- Delete temporary files or move large files to another drive\n` +
              `- Restart the application after freeing up space\n\n`;
          } else {
            installErrorMsg +=
              `Possible causes and solutions:\n` +
              `- Network connectivity issues:\n` +
              `  • Check your internet connection\n` +
              `  • Verify firewall/proxy settings\n` +
              `- Python or pip installation issues:\n` +
              `  • Ensure Python 3.10+ is properly installed\n` +
              `  • Try reinstalling Python from https://www.python.org/downloads/\n` +
              `- Insufficient disk space:\n` +
              `  • Ensure at least 1GB of free disk space\n` +
              `- Antivirus interference:\n` +
              `  • Temporarily disable antivirus and try again\n` +
              `- Corrupted package cache:\n` +
              `  • Clear pip cache: python -m pip cache purge\n\n`;
          }

          installErrorMsg += `Error details:\n${output.slice(0, 500)}${output.length > 500 ? '...' : ''}`;

          this.emit('error', installErrorMsg);
          resolve(false);
        }
      });

      proc.on('error', (err) => {
        console.error('[PythonEnvManager] Error installing deps:', err);

        const pipProcessErrorMsg =
          `Failed to start dependency installation process.\n\n` +
          `Error: ${err.message}\n\n` +
          `This usually indicates:\n` +
          `- The Python virtual environment is corrupted\n` +
          `- pip is not installed or not accessible\n` +
          `- System security software is blocking the process\n\n` +
          `Recommended actions:\n` +
          `1. Restart the application to recreate the virtual environment\n` +
          `2. If the issue persists, delete the virtual environment:\n` +
          `   Location: ${this.getVenvBasePath() || 'undefined'}\n` +
          `3. Verify Python installation:\n` +
          (isWindows()
            ? `   • Open Command Prompt: python -m pip --version\n`
            : `   • Open terminal: python3 -m pip --version\n`) +
          `4. Ensure pip is up to date:\n` +
          (isWindows()
            ? `   • python -m ensurepip --upgrade\n`
            : `   • python3 -m ensurepip --upgrade\n`) +
          `5. Check antivirus settings - add Python to exclusions\n` +
          `6. If all else fails, reinstall Python 3.10+ from:\n` +
          `   https://www.python.org/downloads/`;

        this.emit('error', pipProcessErrorMsg);
        resolve(false);
      });
    });
  }

  /**
   * Initialize the Python environment.
   *
   * For packaged apps: Uses bundled Python + site-packages (no pip install needed)
   * For development: Creates venv and installs deps if needed.
   *
   * If initialization is already in progress, this will wait for and return
   * the existing initialization promise instead of starting a new one.
   */
  async initialize(autoBuildSourcePath: string): Promise<PythonEnvStatus> {
    // If there's already an initialization in progress, wait for it
    if (this.initializationPromise) {
      console.warn('[PythonEnvManager] Initialization already in progress, waiting...');
      return this.initializationPromise;
    }

    // If already ready and pointing to the same source, return cached status
    if (this.isReady && this.autoBuildSourcePath === autoBuildSourcePath) {
      return {
        ready: true,
        pythonPath: this.pythonPath,
        sitePackagesPath: this.sitePackagesPath,
        venvExists: true,
        depsInstalled: true,
        usingBundledPackages: this.usingBundledPackages
      };
    }

    // Start new initialization and store the promise
    this.initializationPromise = this._doInitialize(autoBuildSourcePath);

    try {
      return await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  /**
   * Internal initialization method that performs the actual setup.
   * This is separated from initialize() to support the promise queue pattern.
   */
  private async _doInitialize(autoBuildSourcePath: string): Promise<PythonEnvStatus> {
    this.isInitializing = true;
    this.autoBuildSourcePath = autoBuildSourcePath;

    console.warn('[PythonEnvManager] Initializing with path:', autoBuildSourcePath);

    try {
      // For packaged apps, try to use bundled packages first (no pip install needed!)
      if (app.isPackaged && this.hasBundledPackages()) {
        console.warn('[PythonEnvManager] Using bundled Python packages (no pip install needed)');

        const bundledPython = getBundledPythonPath();
        const bundledSitePackages = this.getBundledSitePackagesPath();

        if (bundledPython && bundledSitePackages) {
          this.pythonPath = bundledPython;
          this.sitePackagesPath = bundledSitePackages;
          this.usingBundledPackages = true;
          this.isReady = true;
          this.isInitializing = false;

          this.emit('ready', this.pythonPath);
          console.warn('[PythonEnvManager] Ready with bundled Python:', this.pythonPath);
          console.warn('[PythonEnvManager] Using bundled site-packages:', this.sitePackagesPath);

          return {
            ready: true,
            pythonPath: this.pythonPath,
            sitePackagesPath: this.sitePackagesPath,
            venvExists: false, // Not using venv
            depsInstalled: true,
            usingBundledPackages: true
          };
        }
      }

      // Fallback to venv-based setup (for development or if bundled packages missing)
      console.warn('[PythonEnvManager] Using venv-based setup (development mode or bundled packages missing)');
      this.usingBundledPackages = false;

      // Check if venv exists
      if (!this.venvExists()) {
        console.warn('[PythonEnvManager] Venv not found, creating...');
        const created = await this.createVenv();
        if (!created) {
          this.isInitializing = false;
          return {
            ready: false,
            pythonPath: null,
            sitePackagesPath: null,
            venvExists: false,
            depsInstalled: false,
            usingBundledPackages: false,
            error:
              `Python environment initialization failed: Could not create virtual environment.\n\n` +
              `The detailed error was already displayed above. Common solutions:\n` +
              `- Install Python 3.10 or higher from https://www.python.org/downloads/\n` +
              (isLinux()
                ? `- Install python3-venv package:\n` +
                  `  • Debian/Ubuntu: sudo apt install python3-venv\n` +
                  `  • Fedora/RHEL: sudo dnf install python3-venv\n`
                : '') +
              `- Ensure at least 500MB of free disk space\n` +
              `- Check that you have write permissions to the application directory\n` +
              `- Try restarting the application\n` +
              `- If using antivirus software, add Python to exclusions`
          };
        }
      } else {
        console.warn('[PythonEnvManager] Venv already exists');
      }

      // Check if deps are installed
      const depsInstalled = await this.checkDepsInstalled();
      if (!depsInstalled) {
        console.warn('[PythonEnvManager] Dependencies not installed, installing...');
        const installed = await this.installDeps();
        if (!installed) {
          this.isInitializing = false;
          return {
            ready: false,
            pythonPath: this.getVenvPythonPath(),
            sitePackagesPath: null,
            venvExists: true,
            depsInstalled: false,
            usingBundledPackages: false,
            error:
              `Python environment initialization failed: Could not install dependencies.\n\n` +
              `The detailed error was already displayed above. Common solutions:\n` +
              `- Check your internet connection (pip needs to download packages)\n` +
              `- Verify firewall/proxy settings allow pip to access PyPI\n` +
              `- Ensure at least 1GB of free disk space\n` +
              `- Try clearing pip cache:\n` +
              (isWindows()
                ? `  python -m pip cache purge\n`
                : `  python3 -m pip cache purge\n`) +
              `- Temporarily disable antivirus software\n` +
              `- If behind a corporate proxy, configure pip:\n` +
              `  pip config set global.proxy http://your-proxy:port\n` +
              `- Wait a few minutes and restart the application (PyPI may be temporarily down)`
          };
        }
      } else {
        console.warn('[PythonEnvManager] Dependencies already installed');
      }

      this.pythonPath = this.getVenvPythonPath();
      // For venv, site-packages is inside the venv
      const venvBase = this.getVenvBasePath();
      if (venvBase) {
        if (isWindows()) {
          // Windows venv structure: Lib/site-packages (no python version subfolder)
          this.sitePackagesPath = path.join(venvBase, 'Lib', 'site-packages');
        } else {
          // Unix venv structure: lib/python3.x/site-packages
          // Dynamically detect Python version from venv lib directory
          const libDir = path.join(venvBase, 'lib');
          let pythonVersion = 'python3.12'; // Fallback to bundled version

          if (existsSync(libDir)) {
            try {
              const entries = readdirSync(libDir);
              const pythonDir = entries.find(e => e.startsWith('python3.'));
              if (pythonDir) {
                pythonVersion = pythonDir;
              }
            } catch {
              // Use fallback version
            }
          }

          this.sitePackagesPath = path.join(venvBase, 'lib', pythonVersion, 'site-packages');
        }
      }

      this.isReady = true;
      this.isInitializing = false;

      this.emit('ready', this.pythonPath);
      console.warn('[PythonEnvManager] Ready with Python path:', this.pythonPath);

      return {
        ready: true,
        pythonPath: this.pythonPath,
        sitePackagesPath: this.sitePackagesPath,
        venvExists: true,
        depsInstalled: true,
        usingBundledPackages: false
      };
    } catch (error) {
      this.isInitializing = false;
      const errorMessage = error instanceof Error ? error.message : String(error);

      const unexpectedErrorMsg =
        `Python environment initialization failed with an unexpected error.\n\n` +
        `Error: ${errorMessage}\n\n` +
        `This is an unexpected issue. Please try the following:\n` +
        `1. Restart the application\n` +
        `2. Ensure you have:\n` +
        `   • Python 3.10 or higher installed\n` +
        `   • At least 1GB of free disk space\n` +
        `   • Internet connectivity for downloading packages\n` +
        `   • Write permissions to the application directory\n` +
        `3. Check system logs for related errors:\n` +
        (isWindows()
          ? `   • Event Viewer > Windows Logs > Application\n`
          : `   • System logs (journalctl or /var/log/)\n`) +
        `4. If the issue persists:\n` +
        (app.isPackaged
          ? `   • Try reinstalling the application\n` +
            `   • Contact support with the error details above\n`
          : `   • Check the development console for additional errors\n` +
            `   • Verify the repository integrity with 'git status'\n`) +
        `5. Temporarily disable antivirus/security software to rule out interference`;

      return {
        ready: false,
        pythonPath: null,
        sitePackagesPath: null,
        venvExists: this.venvExists(),
        depsInstalled: false,
        usingBundledPackages: false,
        error: unexpectedErrorMsg
      };
    }
  }

  /**
   * Get the Python path (only valid after initialization)
   */
  getPythonPath(): string | null {
    return this.pythonPath;
  }

  /**
   * Get the site-packages path (only valid after initialization)
   */
  getSitePackagesPath(): string | null {
    return this.sitePackagesPath;
  }

  /**
   * Check if using bundled packages (vs venv)
   */
  isUsingBundledPackages(): boolean {
    return this.usingBundledPackages;
  }

  /**
   * Check if the environment is ready
   */
  isEnvReady(): boolean {
    return this.isReady;
  }

  /**
   * Get environment variables that should be set when spawning Python processes.
   * This ensures Python finds the bundled packages or venv packages.
   *
   * IMPORTANT: This returns a COMPLETE environment (based on process.env) with
   * problematic Python variables removed. This fixes the "Could not find platform
   * independent libraries <prefix>" error on Windows when PYTHONHOME is set.
   *
   * For Windows with pywin32, this method handles several critical issues:
   * 1. PYTHONPATH must include win32 and win32/lib for module imports
   * 2. pywin32_system32 must be in PATH for DLL loading
   *
   * Note: The DLL copying performed by fixPywin32() in download-python.cjs is what
   * actually makes pywin32 work - it copies DLLs to locations where Python's default
   * DLL search finds them. Adding pywin32_system32 to PATH is an additional fallback.
   *
   * @see https://github.com/AndyMik90/Auto-Claude/issues/176
   * @see https://github.com/AndyMik90/Auto-Claude/issues/810
   * @see https://github.com/mhammond/pywin32/blob/main/win32/Lib/pywin32_bootstrap.py
   */
  getPythonEnv(): Record<string, string> {
    // Start with isolated git env to prevent git environment variable contamination.
    // When running Python scripts that call git (like merge resolver, PR creator),
    // we must not pass GIT_DIR, GIT_WORK_TREE, etc. or git operations will target
    // the wrong repository. getIsolatedGitEnv() removes these variables and sets HUSKY=0.
    //
    // Also remove PYTHONHOME - it causes "Could not find platform independent libraries"
    // when set to a different Python installation than the one we're spawning.
    const isolatedEnv = getIsolatedGitEnv();
    const baseEnv: Record<string, string> = {};

    for (const [key, value] of Object.entries(isolatedEnv)) {
      // Skip PYTHONHOME - it causes the "platform independent libraries" error
      // Use case-insensitive check for Windows compatibility (env vars are case-insensitive on Windows)
      // Skip undefined values (TypeScript type guard)
      const upperKey = key.toUpperCase();
      if (upperKey !== 'PYTHONHOME' && value !== undefined) {
        baseEnv[key] = value;
      }
    }

    // Build PYTHONPATH - for Windows with pywin32, we need to include win32 and win32/lib
    // since the .pth file that normally adds these isn't processed when using PYTHONPATH
    let pythonPath = this.sitePackagesPath || '';
    if (this.sitePackagesPath && isWindows()) {
      const pathSep = getPathDelimiter();  // Platform-appropriate path separator
      const win32Path = path.join(this.sitePackagesPath, 'win32');
      const win32LibPath = path.join(this.sitePackagesPath, 'win32', 'lib');
      pythonPath = [this.sitePackagesPath, win32Path, win32LibPath].join(pathSep);
    }

    // Windows-specific pywin32 DLL loading fix
    // On Windows with bundled packages, we need to ensure pywin32 DLLs can be found.
    // The DLL copying in fixPywin32() is the primary fix - this PATH addition is a fallback.
    const windowsEnv: Record<string, string> = {};
    if (this.sitePackagesPath && isWindows()) {
      const pywin32System32 = path.join(this.sitePackagesPath, 'pywin32_system32');

      // Add pywin32_system32 to PATH for DLL loading
      // Normalize to single 'PATH' key before reading/writing, using the shared utility.
      // This prevents duplicate 'Path'/'PATH' keys that cause DLL-load failures on Windows.
      normalizeEnvPathKey(baseEnv);
      const currentPath = baseEnv['PATH'] ?? '';

      if (currentPath && !currentPath.includes(pywin32System32)) {
        windowsEnv['PATH'] = `${pywin32System32};${currentPath}`;
      } else if (!currentPath) {
        windowsEnv['PATH'] = pywin32System32;
      } else {
        // pywin32System32 already in path, but still normalize to 'PATH'
        windowsEnv['PATH'] = currentPath;
      }
    }

    return {
      ...baseEnv,
      ...windowsEnv,
      // Don't write bytecode - not needed and avoids permission issues
      PYTHONDONTWRITEBYTECODE: '1',
      // Force unbuffered stdout/stderr so progress updates reach Electron immediately
      PYTHONUNBUFFERED: '1',
      // Use UTF-8 encoding
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      // Disable user site-packages to avoid conflicts
      PYTHONNOUSERSITE: '1',
      // Override PYTHONPATH if we have bundled packages
      ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
    };
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<PythonEnvStatus> {
    // If using bundled packages, we're always ready
    if (this.usingBundledPackages && this.pythonPath && this.sitePackagesPath) {
      return {
        ready: true,
        pythonPath: this.pythonPath,
        sitePackagesPath: this.sitePackagesPath,
        venvExists: false,
        depsInstalled: true,
        usingBundledPackages: true
      };
    }

    const venvExists = this.venvExists();
    const depsInstalled = venvExists ? await this.checkDepsInstalled() : false;

    return {
      ready: this.isReady,
      pythonPath: this.pythonPath,
      sitePackagesPath: this.sitePackagesPath,
      venvExists,
      depsInstalled,
      usingBundledPackages: this.usingBundledPackages
    };
  }

  /**
   * Clean up any active processes on app exit.
   * Should be called when the application is about to quit.
   */
  cleanup(): void {
    if (this.activeProcesses.size > 0) {
      console.warn('[PythonEnvManager] Cleaning up', this.activeProcesses.size, 'active process(es)');
      for (const proc of this.activeProcesses) {
        try {
          proc.kill();
        } catch {
          // Process may already be dead
        }
      }
      this.activeProcesses.clear();
    }
  }
}

// Singleton instance
export const pythonEnvManager = new PythonEnvManager();

// Register cleanup on app exit (guard for test environments where app.on may not exist)
if (typeof app?.on === 'function') {
  app.on('will-quit', () => {
    pythonEnvManager.cleanup();
  });
}

/**
 * Get the configured venv Python path if ready, otherwise fall back to system Python.
 * This should be used by ALL services that need to spawn Python processes.
 *
 * Priority:
 * 1. If venv is ready -> return venv Python (has all dependencies installed)
 * 2. Fall back to findPythonCommand() -> bundled or system Python
 *
 * Note: For scripts that require dependencies (dotenv, claude-agent-sdk, etc.),
 * the venv Python MUST be used. Only use this fallback for scripts that
 * don't have external dependencies (like ollama_model_detector.py).
 */
export function getConfiguredPythonPath(): string {
  // If venv is ready, always prefer it (has dependencies installed)
  if (pythonEnvManager.isEnvReady()) {
    const venvPath = pythonEnvManager.getPythonPath();
    if (venvPath) {
      return venvPath;
    }
  }

  // Fall back to system/bundled Python
  return findPythonCommand() || 'python';
}
