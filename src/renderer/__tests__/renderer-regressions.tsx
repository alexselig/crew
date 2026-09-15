import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import { WorkspaceSessionCard } from '../components/WorkspaceSessionCard'
import { TranscriptPane } from '../components/TranscriptPane'
import { getPooled, getTranscript, writeTo } from '../terminal/pool'
import { setEngineMode } from '../terminal/facade'
import { meterInput, pendingInputTokens } from '../input-meter'
import { useSessionDrag } from '../useSessionDrag'
import type { CrewState } from '../hooks'
import type { SessionInfo } from '../../shared/types'
import type { RendererRegressionControls } from '../../../test/fixtures/renderer-regression-types'

const noop = () => {}
const session = (id: string, workspaceIds: string[]): SessionInfo => ({
  id, workspaceIds, label: id, characterId: 'fox', color: '#ff7a3c',
  state: 'WAITING_INPUT', status: 'active', presetId: 'shell',
  command: '/bin/bash', args: [], cwd: '/synthetic', createdAt: 1,
  stateChangedAt: 1, autopilot: false, pid: null, exitCode: null,
  costUsd: 0, creditsUsed: 0
})
const roster = [
  ...Array.from({ length: 9 }, (_, i) => session(`a${i + 1}`, ['a'])),
  ...Array.from({ length: 9 }, (_, i) => session(`b${i + 1}`, ['b']))
]
const controls: RendererRegressionControls = {
  activeWorkspace: 'a',
  selected: [],
  modes: [],
  newDialogs: [],
  windows: 0,
  sent: [],
  workspace: (_id: string | null) => {},
  pilot: (_value: boolean) => {},
  legacy: () => setEngineMode('legacy'),
  transcript: () => getTranscript('composer'),
  complete: () => writeTo('composer', '\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07'),
  pending: () => pendingInputTokens('composer')
}
Object.assign(window, {
  regression: controls,
  crew: {
    sendInput: (id: string, data: string) => controls.sent.push({ id, data }),
    openWindow: () => { controls.windows++ }
  }
})

// Only App's state source and child views are isolated by the test server.
// Its useMemo/useEffect and the browser's keyboard listener lifecycle are real.
export function useCrew(): CrewState {
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>('a')
  controls.activeWorkspace = activeWorkspace
  controls.workspace = setActiveWorkspace
  return {
    roster, activeWorkspace, selectedId: 'unchanged-selection', characters: [],
    presets: [], homeDir: '/synthetic', setSelectedId: noop,
    customViews: [], presentation: { kind: 'builtin', mode: 'none' }, setPresentation: noop,
    showCustomViewEditor: null, setShowCustomViewEditor: noop,
    workspaces: [
      { id: 'a', name: 'A', order: 0, createdAt: 1 },
      { id: 'b', name: 'B', order: 1, createdAt: 1 }
    ],
    agents: [], runs: {}, setActiveRunId: noop, setEditingAgent: noop,
    editingAgent: null, activeRunId: null, showNew: false, showWorkspaces: false,
    settings: null, viewMode: 'grid', gridDensity: 'four', groupMode: 'none',
    setSetting: noop, setGridDensity: noop, setGroupMode: noop,
    navWidth: 300, setNavWidth: noop, navCollapsed: false, setNavCollapsed: noop,
    collapsedGroups: new Set(), toggleGroup: noop,
    minimized: new Set(), toggleMinimize: noop, revealed: new Set(),
    groupOrder: [], reorderGroups: noop, setActiveWorkspace,
    refreshWorkspaces: noop, setShowWorkspaces: noop,
    selectSession: (id: string) => controls.selected.push(id),
    setViewMode: (mode: string) => controls.modes.push(mode),
    setShowNew: (show: boolean) => controls.newDialogs.push(show)
  }
}

function WorkspaceFixture() {
  const [autopilot, setAutopilot] = useState(false)
  const drag = useSessionDrag(noop)
  controls.pilot = setAutopilot
  return <WorkspaceSessionCard
    session={{ ...roster[0], autopilot }} characters={[]} laneId="a" workspaces={[]}
    drag={drag}
    onRename={noop} onDescribe={noop} onArchive={noop} onDuplicate={noop}
    onMoveTo={noop} onRemoveFrom={noop} onOpen={noop}
  />
}

const kind = new URLSearchParams(location.search).get('fixture')
if (kind === 'composer') {
  setEngineMode('crew')
  getPooled('composer')
  meterInput('composer', 'pending terminal input')
}
createRoot(document.getElementById('root')!).render(
  kind === 'workspace' ? <WorkspaceFixture /> :
  kind === 'composer' ? <TranscriptPane sessionId="composer" enhanced /> : <App />
)
