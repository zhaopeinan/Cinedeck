import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET || 'ppt-audio-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';
const CAPTCHA_TOLERANCE = 8; // 滑块验证码容差（像素）
const CAPTCHA_EXPIRE_MS = 5 * 60 * 1000; // 验证码 5 分钟过期
const MAX_LOGIN_ATTEMPTS = 5; // 最大登录失败次数
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 锁定 15 分钟

export interface User {
  id: string;
  username: string;
  role: string;
  status: string;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CaptchaChallenge {
  captchaId: string;
  backgroundImage: string; // SVG data URL
  sliderImage: string; // SVG data URL
  sliderY: number; // 滑块 Y 坐标（已知）
  canvasWidth: number;
  canvasHeight: number;
  sliderSize: number;
}

interface CaptchaRecord {
  captchaId: string;
  targetX: number;
  expireAt: number;
  verified: boolean;
}

interface LoginAttemptRecord {
  attempts: number;
  lockedUntil: number;
}

export class AuthService {
  private db: Database.Database;
  private captchaStore = new Map<string, CaptchaRecord>();
  private loginAttempts = new Map<string, LoginAttemptRecord>();

  constructor(db: Database.Database) {
    this.db = db;
    this.initDefaultAdmin();
  }

  /** 初始化默认管理员账号 */
  private initDefaultAdmin() {
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
    if (count === 0) {
      const id = uuidv4();
      const now = new Date().toISOString();
      const hash = bcrypt.hashSync('admin123', 10);
      this.db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
        VALUES (?, ?, ?, 'admin', 'active', ?, ?)
      `).run(id, 'admin', hash, now, now);
      console.log('[Auth] 默认管理员账号已创建: admin / admin123');
    }
  }

  /** 生成滑块验证码 */
  generateCaptcha(): CaptchaChallenge {
    const captchaId = uuidv4();
    const canvasWidth = 320;
    const canvasHeight = 160;
    const sliderSize = 44;
    const targetX = Math.floor(Math.random() * (canvasWidth - sliderSize - 20)) + 10;
    const sliderY = Math.floor(Math.random() * (canvasHeight - sliderSize - 20)) + 10;

    // 生成带噪点的渐变背景 SVG
    const bgColors = [
      ['#667eea', '#764ba2'],
      ['#f093fb', '#f5576c'],
      ['#4facfe', '#00f2fe'],
      ['#43e97b', '#38f9d7'],
      ['#fa709a', '#fee140'],
      ['#a8edea', '#fed6e3'],
      ['#ff9a9e', '#fecfef'],
      ['#ffecd2', '#fcb69f'],
    ];
    const [c1, c2] = bgColors[Math.floor(Math.random() * bgColors.length)];

    // 噪点
    let noiseElements = '';
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * canvasWidth;
      const y = Math.random() * canvasHeight;
      const r = Math.random() * 1.5 + 0.5;
      const opacity = Math.random() * 0.3 + 0.1;
      const color = Math.random() > 0.5 ? '#fff' : '#000';
      noiseElements += `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>`;
    }

    // 随机干扰线
    let lineElements = '';
    for (let i = 0; i < 4; i++) {
      const x1 = Math.random() * canvasWidth;
      const y1 = Math.random() * canvasHeight;
      const x2 = Math.random() * canvasWidth;
      const y2 = Math.random() * canvasHeight;
      lineElements += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`;
    }

    // 背景图（带缺口）
    const backgroundImage = `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:${c1}"/>
            <stop offset="100%" style="stop-color:${c2}"/>
          </linearGradient>
        </defs>
        <rect width="${canvasWidth}" height="${canvasHeight}" fill="url(#bg)"/>
        ${noiseElements}
        ${lineElements}
        <!-- 缺口 -->
        <rect x="${targetX}" y="${sliderY}" width="${sliderSize}" height="${sliderSize}" rx="4" fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.5)" stroke-width="1"/>
      </svg>`
    ).toString('base64')}`;

    // 滑块图
    const sliderImage = `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${sliderSize}" height="${sliderSize}">
        <rect width="${sliderSize}" height="${sliderSize}" rx="4" fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.2)" stroke-width="1"/>
        <text x="${sliderSize / 2}" y="${sliderSize / 2 + 4}" text-anchor="middle" font-size="14" fill="#666">≡</text>
      </svg>`
    ).toString('base64')}`;

    this.captchaStore.set(captchaId, {
      captchaId,
      targetX,
      expireAt: Date.now() + CAPTCHA_EXPIRE_MS,
      verified: false,
    });

    return {
      captchaId,
      backgroundImage,
      sliderImage,
      sliderY,
      canvasWidth,
      canvasHeight,
      sliderSize,
    };
  }

  /** 校验滑块验证码 */
  verifyCaptcha(captchaId: string, sliderX: number): { success: boolean; token?: string; message: string } {
    const record = this.captchaStore.get(captchaId);
    if (!record) {
      return { success: false, message: '验证码不存在或已过期' };
    }
    if (Date.now() > record.expireAt) {
      this.captchaStore.delete(captchaId);
      return { success: false, message: '验证码已过期，请刷新' };
    }
    if (record.verified) {
      return { success: false, message: '验证码已被使用' };
    }
    if (Math.abs(sliderX - record.targetX) > CAPTCHA_TOLERANCE) {
      return { success: false, message: '验证失败，请重试' };
    }
    // 验证通过，生成 token（用于登录）
    record.verified = true;
    const token = uuidv4();
    this.captchaStore.set(token, {
      captchaId: token,
      targetX: -1, // 标记为已验证的 token
      expireAt: Date.now() + 5 * 60 * 1000,
      verified: true,
    });
    this.captchaStore.delete(captchaId);
    return { success: true, token, message: '验证通过' };
  }

  /** 登录 */
  login(username: string, password: string, captchaToken: string): { success: boolean; token?: string; user?: User; message: string } {
    // 检查验证码 token
    const captchaRecord = this.captchaStore.get(captchaToken);
    if (!captchaRecord || !captchaRecord.verified || captchaRecord.targetX !== -1) {
      return { success: false, message: '请先完成滑块验证' };
    }
    if (Date.now() > captchaRecord.expireAt) {
      this.captchaStore.delete(captchaToken);
      return { success: false, message: '验证码已过期，请重新验证' };
    }
    // 消费验证码 token
    this.captchaStore.delete(captchaToken);

    // 检查账号锁定
    const attempt = this.loginAttempts.get(username) || { attempts: 0, lockedUntil: 0 };
    if (attempt.lockedUntil > Date.now()) {
      const mins = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
      return { success: false, message: `账号已锁定，请 ${mins} 分钟后再试` };
    }

    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
    if (!row) {
      this.recordFailedAttempt(username);
      return { success: false, message: '用户名或密码错误' };
    }
    if (row.status !== 'active') {
      return { success: false, message: '账号已被禁用' };
    }

    if (!bcrypt.compareSync(password, row.password_hash)) {
      this.recordFailedAttempt(username);
      return { success: false, message: '用户名或密码错误' };
    }

    // 登录成功，清除失败记录
    this.loginAttempts.delete(username);

    const now = new Date().toISOString();
    this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id);

    const user: User = {
      id: row.id,
      username: row.username,
      role: row.role,
      status: row.status,
      last_login_at: now,
      created_at: row.created_at,
      updated_at: now,
    };

    const token = jwt.sign({ id: row.id, username: row.username, role: row.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    return { success: true, token, user, message: '登录成功' };
  }

  private recordFailedAttempt(username: string) {
    const attempt = this.loginAttempts.get(username) || { attempts: 0, lockedUntil: 0 };
    attempt.attempts++;
    if (attempt.attempts >= MAX_LOGIN_ATTEMPTS) {
      attempt.lockedUntil = Date.now() + LOGIN_LOCK_MS;
      attempt.attempts = 0;
    }
    this.loginAttempts.set(username, attempt);
  }

  /** 验证 JWT */
  verifyToken(token: string): { id: string; username: string; role: string } | null {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      return { id: decoded.id, username: decoded.username, role: decoded.role };
    } catch {
      return null;
    }
  }

  /** 获取用户信息 */
  getUserById(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      status: row.status,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** 获取所有用户 */
  getAllUsers(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as any[];
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      status: row.status,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  /** 创建用户 */
  createUser(data: { username: string; password: string; role?: string }): User {
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(data.username);
    if (existing) throw new Error('用户名已存在');

    const id = uuidv4();
    const now = new Date().toISOString();
    const hash = bcrypt.hashSync(data.password, 10);
    this.db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, data.username, hash, data.role || 'user', now, now);

    return this.getUserById(id)!;
  }

  /** 更新用户 */
  updateUser(id: string, data: { password?: string; role?: string; status?: string }): User | null {
    const user = this.getUserById(id);
    if (!user) return null;
    const now = new Date().toISOString();
    const updates: string[] = ['updated_at = ?'];
    const params: any[] = [now];

    if (data.password) {
      updates.push('password_hash = ?');
      params.push(bcrypt.hashSync(data.password, 10));
    }
    if (data.role) {
      updates.push('role = ?');
      params.push(data.role);
    }
    if (data.status) {
      updates.push('status = ?');
      params.push(data.status);
    }
    params.push(id);
    this.db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.getUserById(id);
  }

  /** 删除用户 */
  deleteUser(id: string): boolean {
    const user = this.getUserById(id);
    if (!user) return false;
    if (user.username === 'admin') throw new Error('不能删除默认管理员账号');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return true;
  }

  /** 重置密码 */
  resetPassword(id: string, newPassword: string): boolean {
    const user = this.getUserById(id);
    if (!user) return false;
    const now = new Date().toISOString();
    const hash = bcrypt.hashSync(newPassword, 10);
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, id);
    return true;
  }

  /** 修改密码 */
  changePassword(id: string, oldPassword: string, newPassword: string): { success: boolean; message: string } {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as any;
    if (!row) return { success: false, message: '用户不存在' };
    if (!bcrypt.compareSync(oldPassword, row.password_hash)) {
      return { success: false, message: '原密码错误' };
    }
    const now = new Date().toISOString();
    const hash = bcrypt.hashSync(newPassword, 10);
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, id);
    return { success: true, message: '密码修改成功' };
  }

  /** 记录操作日志 */
  logOperation(data: { userId?: string; username?: string; action: string; target?: string; ip?: string; userAgent?: string; details?: string; status?: string }) {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO operation_logs (id, user_id, username, action, target, ip, user_agent, details, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.userId || null, data.username || null, data.action, data.target || null, data.ip || null, data.userAgent || null, data.details || null, data.status || 'success', now);
  }

  /** 查询操作日志 */
  getLogs(options: { page?: number; pageSize?: number; userId?: string; action?: string; status?: string }): { logs: any[]; total: number } {
    const page = options.page || 1;
    const pageSize = options.pageSize || 20;
    const offset = (page - 1) * pageSize;

    let where = '1=1';
    const params: any[] = [];
    if (options.userId) {
      where += ' AND user_id = ?';
      params.push(options.userId);
    }
    if (options.action) {
      where += ' AND action LIKE ?';
      params.push(`%${options.action}%`);
    }
    if (options.status) {
      where += ' AND status = ?';
      params.push(options.status);
    }

    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM operation_logs WHERE ${where}`).get(...params) as any).c;
    const logs = this.db.prepare(`SELECT * FROM operation_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);

    return { logs, total };
  }

  /** 获取系统统计信息 */
  getStats(): { userCount: number; activeUserCount: number; logCount: number; todayLogCount: number; projectCount: number } {
    const userCount = (this.db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
    const activeUserCount = (this.db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'active'").get() as any).c;
    const logCount = (this.db.prepare('SELECT COUNT(*) as c FROM operation_logs').get() as any).c;
    const today = new Date().toISOString().slice(0, 10);
    const todayLogCount = (this.db.prepare("SELECT COUNT(*) as c FROM operation_logs WHERE created_at LIKE ?").get(`${today}%`) as any).c;
    const projectCount = (this.db.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c;
    return { userCount, activeUserCount, logCount, todayLogCount, projectCount };
  }
}
