import { ChildProcess, spawn } from 'child_process';
import axios from 'axios';
import path from 'path';
import fs from 'fs';

const VOICEBOX_BASE_URL = process.env.VOICEBOX_BASE_URL || 'http://localhost:17493';
const VOICEBOX_PORT = parseInt(VOICEBOX_BASE_URL.split(':').pop() || '17493', 10);
const VOICEBOX_HOST = VOICEBOX_BASE_URL.replace(/^https?:\/\//, '').split(':')[0];

/**
 * Manages the Voicebox subprocess lifecycle.
 * On first use, auto-clones the repo if missing, then starts the backend server.
 * Restarts on crash. Shuts down when the parent process exits.
 */
export class VoiceboxProcessManager {
  private process: ChildProcess | null = null;
  private baseUrl: string;
  private starting = false;
  private voiceboxDir: string;

  constructor() {
    this.baseUrl = VOICEBOX_BASE_URL;
    // Resolve Voicebox directory: env var, or sibling of project
    this.voiceboxDir = process.env.VOICEBOX_DIR ||
      path.resolve(process.cwd(), '..', 'voicebox');
  }

  /**
   * Ensure Voicebox is running. Returns true if available.
   * If not running, attempts to clone (if needed) and start.
   */
  async ensureRunning(): Promise<boolean> {
    // Already running?
    if (await this.healthCheck()) return true;
    if (this.starting) return false;

    this.starting = true;
    try {
      // Step 1: Clone if missing
      if (!this.isInstalled()) {
        console.log('[Voicebox] Not found, cloning repository...');
        await this.clone();
      }

      // Step 2: Install dependencies if needed
      if (!this.hasDependencies()) {
        console.log('[Voicebox] Installing dependencies...');
        await this.installDeps();
      }

      // Step 3: Start the process
      console.log('[Voicebox] Starting backend server...');
      this.startProcess();

      // Step 4: Wait for health check to pass
      const ok = await this.waitForReady(60);
      if (ok) {
        console.log('[Voicebox] Server is ready at', this.baseUrl);
      } else {
        console.warn('[Voicebox] Server did not become ready in time');
      }
      return ok;
    } catch (err: any) {
      console.error('[Voicebox] Failed to start:', err.message);
      return false;
    } finally {
      this.starting = false;
    }
  }

  /**
   * Check if Voicebox is responding.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await axios.get(`${this.baseUrl}/health`, { timeout: 3000 });
      return res.data?.status === 'healthy';
    } catch {
      return false;
    }
  }

  /**
   * Stop the Voicebox subprocess.
   */
  stop(): void {
    if (this.process && !this.process.killed) {
      console.log('[Voicebox] Stopping server...');
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  private isInstalled(): boolean {
    return fs.existsSync(path.join(this.voiceboxDir, 'backend', 'app.py'));
  }

  private hasDependencies(): boolean {
    // Check if venv or requirements are installed
    const venvPath = path.join(this.voiceboxDir, '.venv');
    const localLibPath = path.join(this.voiceboxDir, 'backend', '__pycache__');
    return fs.existsSync(venvPath) || fs.existsSync(localLibPath);
  }

  private async clone(): Promise<void> {
    return new Promise((resolve, reject) => {
      const parentDir = path.dirname(this.voiceboxDir);
      fs.mkdirSync(parentDir, { recursive: true });

      const git = spawn('git', [
        'clone', '--depth', '1',
        'https://github.com/jamiepine/voicebox.git',
        this.voiceboxDir,
      ], { stdio: 'pipe' });

      let stderr = '';
      git.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      git.on('close', (code) => {
        if (code === 0) {
          console.log('[Voicebox] Repository cloned successfully');
          resolve();
        } else {
          reject(new Error(`git clone failed (code ${code}): ${stderr}`));
        }
      });

      git.on('error', (err) => reject(err));
    });
  }

  private async installDeps(): Promise<void> {
    return new Promise((resolve, reject) => {
      const reqFile = path.join(this.voiceboxDir, 'requirements.txt');
      if (!fs.existsSync(reqFile)) {
        // No requirements.txt - skip
        resolve();
        return;
      }

      const pip = spawn('pip', ['install', '-r', reqFile], {
        cwd: this.voiceboxDir,
        stdio: 'pipe',
      });

      let stderr = '';
      pip.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      pip.on('close', (code) => {
        if (code === 0) {
          console.log('[Voicebox] Dependencies installed');
          resolve();
        } else {
          // Don't fail hard - Voicebox might already have deps
          console.warn('[Voicebox] pip install had issues (code ${code}), continuing...');
          resolve();
        }
      });

      pip.on('error', () => {
        // pip not found - try pip3
        const pip3 = spawn('pip3', ['install', '-r', reqFile], {
          cwd: this.voiceboxDir,
          stdio: 'pipe',
        });

        pip3.on('close', () => resolve());
        pip3.on('error', () => resolve()); // Best effort
      });
    });
  }

  private startProcess(): void {
    if (this.process && !this.process.killed) return;

    const pythonCmd = this.findPython();

    this.process = spawn(pythonCmd, [
      '-m', 'backend.main',
      '--host', VOICEBOX_HOST,
      '--port', String(VOICEBOX_PORT),
    ], {
      cwd: this.voiceboxDir,
      stdio: 'pipe',
      env: { ...process.env },
    });

    this.process.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log('[Voicebox]', line);
    });

    this.process.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.error('[Voicebox]', line);
    });

    this.process.on('exit', (code) => {
      console.warn(`[Voicebox] Process exited with code ${code}`);
      this.process = null;
      // Auto-restart after 5 seconds unless we're shutting down
      if (!this.starting) {
        setTimeout(() => {
          if (!this.process) {
            console.log('[Voicebox] Auto-restarting...');
            this.startProcess();
          }
        }, 5000);
      }
    });

    this.process.on('error', (err) => {
      console.error('[Voicebox] Process error:', err.message);
      this.process = null;
    });
  }

  private findPython(): string {
    // Try python3 first, then python
    const venvPython = path.join(this.voiceboxDir, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) return venvPython;
    return 'python3';
  }

  private async waitForReady(maxSeconds: number): Promise<boolean> {
    for (let i = 0; i < maxSeconds; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await this.healthCheck()) return true;
    }
    return false;
  }
}
