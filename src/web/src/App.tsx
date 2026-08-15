import { useAppGate } from './hooks/useAppGate.js';
import { OnboardingPage } from './pages/OnboardingPage.js';
import { SyncingPage } from './pages/SyncingPage.js';
import { WorkspaceShell } from './pages/WorkspaceShell.js';
import { ScreenLock } from './components/ScreenLock.js';

export default function App() {
  const gate = useAppGate();

  let content;
  if (gate.phase === 'loading') {
    content = (
      <div className="flex h-full items-center justify-center bg-surface-0 text-sm text-gray-400">
        Connecting to WhatchatAI backend…
      </div>
    );
  } else if (gate.phase === 'onboarding') {
    content = <OnboardingPage connection={gate.connection} />;
  } else if (gate.phase === 'syncing') {
    content = <SyncingPage connection={gate.connection} sync={gate.sync} onContinueAnyway={gate.continueAnyway} />;
  } else {
    content = <WorkspaceShell connection={gate.connection} sync={gate.sync} />;
  }

  return <ScreenLock>{content}</ScreenLock>;
}
