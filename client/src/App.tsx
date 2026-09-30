import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ConfigProvider, Spin } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import HubPage from './pages/HubPage';
import HomePage from './pages/HomePage';
import AvatarPage from './pages/AvatarPage';
import MoocPage from './pages/MoocPage';
import NotesCheckPage from './pages/NotesCheckPage';
import VoiceWorkshopPage from './pages/VoiceWorkshopPage';
import VoiceFactoryPage from './pages/VoiceFactoryPage';
import TranscribePage from './pages/TranscribePage';
import HyperFramePage from './pages/HyperFramePage';
import DubbingPage from './pages/DubbingPage';
import ProjectAvatarPage from './pages/ProjectAvatarPage';
import VideoPreviewPage from './pages/VideoPreviewPage';
import EditorPage from './pages/EditorPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import { AdminPage } from './pages/AdminPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import GpuStatusBar from './components/GpuStatusBar';
import AppTopActions from './components/AppTopActions';
import { useAuthStore } from './stores/authStore';

/** 路由守卫：未登录跳转登录页 */
const RequireAuth: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const location = useLocation();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    if (token && !user) {
      initialize();
    }
  }, [token, user, initialize]);

  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (loading || (token && !user)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }

  return (
    <>
      <GpuStatusBar />
      <AppTopActions />
      {children}
    </>
  );
};

/** 管理员守卫：非管理员跳转首页 */
const RequireAdmin: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const user = useAuthStore((s) => s.user);
  if (user && user.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  return children;
};

/** 登录页守卫：已登录则跳转首页 */
const RedirectIfAuthed: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  if (token && user) {
    return <Navigate to="/" replace />;
  }
  return children;
};

const App: React.FC = () => {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <ErrorBoundary>
          <Routes>
            {/* 公开路由 */}
            <Route path="/login" element={<RedirectIfAuthed><LoginPage /></RedirectIfAuthed>} />

            {/* 受保护路由 */}
            <Route path="/" element={<RequireAuth><HubPage /></RequireAuth>} />
            <Route path="/ppt" element={<RequireAuth><HomePage /></RequireAuth>} />
            <Route path="/avatar" element={<RequireAuth><AvatarPage /></RequireAuth>} />
            <Route path="/mooc" element={<RequireAuth><MoocPage /></RequireAuth>} />
            <Route path="/voice-factory" element={<RequireAuth><VoiceFactoryPage /></RequireAuth>} />
            <Route path="/transcribe" element={<RequireAuth><TranscribePage /></RequireAuth>} />
            <Route path="/hyperframe" element={<RequireAuth><HyperFramePage /></RequireAuth>} />
            <Route path="/project/:id/notes" element={<RequireAuth><NotesCheckPage /></RequireAuth>} />
            <Route path="/project/:id/voice" element={<RequireAuth><VoiceWorkshopPage /></RequireAuth>} />
            <Route path="/project/:id/dubbing" element={<RequireAuth><DubbingPage /></RequireAuth>} />
            <Route path="/project/:id/avatar" element={<RequireAuth><ProjectAvatarPage /></RequireAuth>} />
            <Route path="/project/:id/preview" element={<RequireAuth><VideoPreviewPage /></RequireAuth>} />
            <Route path="/project/:id/editor" element={<RequireAuth><EditorPage /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />

            {/* 管理员路由 */}
            <Route path="/admin" element={<RequireAuth><RequireAdmin><AdminPage /></RequireAdmin></RequireAuth>} />

            {/* 兜底 */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </BrowserRouter>
    </ConfigProvider>
  );
};

export default App;
