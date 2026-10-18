/**
 * 线性 SVG 图标集 (统一替代 emoji)
 * stroke 风格: 1.5px 线性描边, 24x24 viewBox
 */
const base = (children) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-5 h-5 shrink-0"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const IconHome = () => base(<><path d="M3 10.5L12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>);
export const IconBrain = () => base(<><path d="M12 4a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.5A3 3 0 0 1 15 18a3 3 0 0 1-6 0 3 3 0 0 1-1.5-5.5A3 3 0 0 1 9 7a3 3 0 0 1 3-3z" /><path d="M12 7v4M9.5 12.5H7M14.5 12.5H17" /></>);
export const IconKey = () => base(<><circle cx="8" cy="12" r="4" /><path d="M11 12h9M16 12v3M19 12v2" /></>);
export const IconHistory = () => base(<><path d="M4 12a8 8 0 1 0 2.3-5.6" /><path d="M4 4v4h4" /><path d="M12 8v4l3 2" /></>);
export const IconDashboard = () => base(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>);
export const IconPlug = () => base(<><path d="M9 7V3M15 7V3" /><path d="M6 7h12v4a6 6 0 0 1-12 0V7z" /><path d="M12 17v4" /></>);
export const IconUsers = () => base(<><circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M17.5 14.4c2.3.8 3.5 2.6 3.5 5.6" /></>);
export const IconLogs = () => base(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>);
export const IconChart = () => base(<path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />);
export const IconSettings = () => base(<><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" /></>);
export const IconPrice = () => base(<><circle cx="12" cy="12" r="9" /><path d="M12 7v10M15 9.5c-.5-.8-1.5-1.2-3-1.2-1.5 0-2.5.7-2.5 1.8 0 2.6 5.5 1.3 5.5 3.9 0 1.1-1 1.8-2.5 1.8-1.5 0-2.5-.4-3-1.2" /></>);
export const IconBackup = () => base(<><path d="M12 3v9" /><path d="M8 7l4-4 4 4" /><path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /></>);
export const IconShield = () => base(<><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></>);
export const IconWallet = () => base(<><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18M16 15h2" /></>);
export const IconCalendar = () => base(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>);
export const IconLayers = () => base(<><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></>);
export const IconArrow = () => base(<path d="M5 12h14M13 6l6 6-6 6" />);
