import { useAppGate } from './hooks/useAppGate.js';
import { OnboardingPage } from './pages/OnboardingPage.js';
import { SyncingPage } from './pages/SyncingPage.js';
import { WorkspaceShell } from './pages/WorkspaceShell.js';

export default function App() {
  const gate = useAppGate();

  if (gate.phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-surface-0 text-sm text-gray-400">
        Connecting to WhatchatAI backend…
      </div>
    );
  }

  if (gate.phase === 'onboarding') {
    return <OnboardingPage connection={gate.connection} />;
  }

  if (gate.phase === 'syncing') {
    return <SyncingPage connection={gate.connection} sync={gate.sync} onContinueAnyway={gate.continueAnyway} />;
  }

  return <WorkspaceShell connection={gate.connection} sync={gate.sync} />;
}
