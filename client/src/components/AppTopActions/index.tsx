import React from 'react';
import { Button } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

/** 各页右上角统一操作：返回工作台 / 后台 / 设置 / 退出 */
export const AppTopActions: React.FC<{ showWorkbench?: boolean }> = ({ showWorkbench }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const authUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const onHub = location.pathname === '/';
  const showWb = showWorkbench ?? !onHub;

  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        right: 16,
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        zIndex: 1100,
        padding: '4px 8px',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.92)',
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
      }}
    >
      {showWb && (
        <Button type="text" onClick={() => navigate('/')}>返回工作台</Button>
      )}
      {authUser?.role === 'admin' && (
        <Button type="text" onClick={() => navigate('/admin')}>后台管理</Button>
      )}
      <Button type="text" onClick={() => navigate('/settings')}>设置</Button>
      <Button type="text" danger onClick={() => { logout(); navigate('/login'); }}>退出登录</Button>
    </div>
  );
};

export default AppTopActions;
