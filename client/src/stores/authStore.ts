import { create } from 'zustand';
import axios from 'axios';

export interface AuthUser {
  id: string;
  username: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  loading: boolean;
  setAuth: (token: string, user: AuthUser) => void;
  logout: () => void;
  fetchMe: () => Promise<void>;
  initialize: () => Promise<void>;
}

const TOKEN_KEY = 'ppt_audio_token';

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem(TOKEN_KEY),
  user: null,
  loading: false,

  setAuth: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    set({ token, user });
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    set({ token: null, user: null });
  },

  fetchMe: async () => {
    const token = get().token;
    if (!token) return;
    try {
      const res = await axios.get('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.data.success) {
        set({ user: res.data.data });
      }
    } catch {
      get().logout();
    }
  },

  initialize: async () => {
    const token = get().token;
    if (!token) return;
    set({ loading: true });
    try {
      const res = await axios.get('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.data.success) {
        set({ user: res.data.data, loading: false });
      } else {
        get().logout();
        set({ loading: false });
      }
    } catch {
      get().logout();
      set({ loading: false });
    }
  },
}));
