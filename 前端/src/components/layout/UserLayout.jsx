import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import PanelBackground from './PanelBackground';

export default function UserLayout() {
  return (
    <div className="flex min-h-screen relative">
      <PanelBackground />
      <div className="relative z-10 flex min-h-screen w-full">
        <Sidebar />
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
