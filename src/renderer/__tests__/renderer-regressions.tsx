import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { App } from '../App'
import { GroupPicker } from '../components/GroupPicker'
import { Roster } from '../components/Roster'
import { GridView } from '../components/GridView'
import { WorkspaceSessionCard } from '../components/WorkspaceSessionCard'
import { TranscriptPane } from '../components/TranscriptPane'
import { CustomViewOrganizer } from '../components/CustomViewOrganizer'
import { getPooled, getTranscript, writeTo } from '../terminal/pool'
import { setEngineMode } from '../terminal/facade'
import { meterInput, pendingInputTokens } from '../input-meter'
import { useSessionDrag } from '../useSessionDrag'
import { useCrew as useLiveCrew, type CrewState } from '../hooks'
import type { SessionInfo, CustomView, SessionPresentation, Settings } from '../../shared/types'
import type { RendererRegressionControls } from '../../../test/fixtures/renderer-regression-types'

const noop = () => {}
const session = (id: string, workspaceIds: string[], lastPromptAt = Number(id.replace(/\D/g, '')) || 1): SessionInfo => ({
  id, workspaceIds, label: id, characterId: 'fox', color: '#ff7a3c',
  state: 'WAITING_INPUT', status: 'active', presetId: 'shell',
  command: '/bin/bash', args: [], cwd: '/synthetic', createdAt: 1,
  stateChangedAt: 1, lastPromptAt, autopilot: false, pid: null, exitCode: null,
  costUsd: 0, creditsUsed: 0
})
const roster = [
  ...Array.from({ length: 9 }, (_, i) => session(`a${i + 1}`, ['a'])),
  ...Array.from({ length: 9 }, (_, i) => session(`b${i + 1}`, ['b']))
]
const customViews: CustomView[] = [
  {
    id: 'focus',
    name: 'Release queue',
    mode: 'ranked-plus-all',
    items: [
      { sessionId: 'b9', labelSnapshot: 'b9' },
      { sessionId: 'a2', labelSnapshot: 'a2' }
    ],
    createdAt: 1,
    updatedAt: 1
  },
  {
    id: 'solo',
    name: 'Today only',
    mode: 'curated-only',
    items: [{ sessionId: 'a4', labelSnapshot: 'a4' }],
    createdAt: 1,
    updatedAt: 1
  }
]
const exitedRoster: SessionInfo[] = [
  { ...session('x1', ['a'], 1), status: 'exited', state: 'EXITED' as const, pid: null, exitCode: 0 },
  { ...session('x2', ['a'], 2), status: 'exited', state: 'EXITED' as const, pid: null, exitCode: 0 }
]
const organizerRoster: SessionInfo[] = [
  { ...session('a1', ['a'], 4), label: 'Alpha build', presetId: 'shell', tag: 'release' },
  {
    ...session('a2', ['a'], 3),
    label: 'Beta review',
    presetId: 'copilot-cli',
    status: 'exited',
    state: 'EXITED',
    pid: null,
    exitCode: 0
  },
  { ...session('b1', ['b'], 2), label: 'Gamma docs', presetId: null, tag: 'docs' },
  { ...session('b2', ['b'], 1), label: 'Delta test', presetId: 'shell' }
]
const organizerView: CustomView = {
  id: 'organizer-view',
  name: 'Release queue',
  mode: 'ranked-plus-all',
  items: [
    { sessionId: 'a2', labelSnapshot: 'Beta review' },
    { sessionId: 'missing-session', labelSnapshot: 'Recovered deploy' },
    { sessionId: 'b1', labelSnapshot: 'Gamma docs' }
  ],
  createdAt: 1,
  updatedAt: 2
}
const organizerWorkspaces = [
  { id: 'a', name: 'Application', order: 0, createdAt: 1 },
  { id: 'b', name: 'Documentation', order: 1, createdAt: 1 }
]
const organizerPresets = [
  { id: 'shell', name: 'Shell', command: '/bin/bash', args: [] },
  { id: 'copilot-cli', name: 'Copilot CLI', command: 'copilot', args: [] }
]
const defaultSettings: Settings = {
  notifications: true,
  sound: true,
  notifyOnlyWhenUnfocused: false,
  sortNeedsYouFirst: false,
  launchAtLogin: false,
  showSpend: true,
  showCredits: false,
  costMode: 'auto',
  aicPerUsd: 100,
  resumeConversations: true,
  contextMode: 'auto',
  budgetUsd: 0,
  inputTokenWarn: 100000,
  captureTranscripts: false,
  staleHideHours: 72,
  minimizedAsList: true,
  enhancedTerminal: false,
  showGithubButton: true,
  githubButtonOpensRepo: true
}
const controls: RendererRegressionControls = {
  activeWorkspace: 'a',
  currentSelected: null,
  selected: [],
  modes: [],
  presentations: [],
  newDialogs: [],
  windows: 0,
  sent: [],
  reorders: [],
  createdCustomViews: 0,
  editedCustomViewIds: [],
  customViewCreates: [],
  customViewUpdates: [],
  customViewDeletes: [],
  failCustomViewWrites: false,
  holdCustomViewWrites: false,
  focusedTerminals: [],
  paletteSessionItems: [],
  workspace: (_id: string | null) => {},
  pilot: (_value: boolean) => {},
  present: (_value: string) => {},
  view: (_value: 'single' | 'grid') => {},
  removeOrganizerView: () => {},
  releaseCustomViewWrite: () => {},
  legacy: () => setEngineMode('legacy'),
  transcript: () => getTranscript('composer'),
  complete: () => writeTo('composer', '\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07'),
  pending: () => pendingInputTokens('composer')
}
let releaseCustomViewWrite: (() => void) | null = null
const waitForCustomViewWrite = async (): Promise<void> => {
  if (!controls.holdCustomViewWrites) return
  await new Promise<void>((resolve) => {
    releaseCustomViewWrite = resolve
  })
}
controls.releaseCustomViewWrite = () => {
  releaseCustomViewWrite?.()
  releaseCustomViewWrite = null
}
Object.assign(window, {
  regression: controls,
  crew: {
    sendInput: (id: string, data: string) => controls.sent.push({ id, data }),
    openWindow: () => { controls.windows++ },
    reorder: (ids: string[]) => { controls.reorders.push(ids) },
    createCustomView: async (input: Parameters<typeof window.crew.createCustomView>[0]) => {
      controls.customViewCreates.push(structuredClone(input))
      if (controls.failCustomViewWrites) throw new Error('Synthetic create failure')
      await waitForCustomViewWrite()
      return [
        ...customViews,
        {
          id: 'created-view',
          ...input,
          createdAt: 10,
          updatedAt: 10
        }
      ]
    },
    updateCustomView: async (
      id: string,
      input: Parameters<typeof window.crew.updateCustomView>[1]
    ) => {
      controls.customViewUpdates.push({ id, input: structuredClone(input) })
      if (controls.failCustomViewWrites) throw new Error('Synthetic update failure')
      await waitForCustomViewWrite()
      return customViews.map((view) =>
        view.id === id ? { ...view, ...input, updatedAt: view.updatedAt + 1 } : view
      )
    },
    deleteCustomView: async (id: string) => {
      controls.customViewDeletes.push(id)
      if (controls.failCustomViewWrites) throw new Error('Synthetic delete failure')
      return customViews.filter((view) => view.id !== id)
    }
  }
})

// Only App's state source and child views are isolated by the test server.
// Its useMemo/useEffect and the browser's keyboard listener lifecycle are real.
export function useCrew(): CrewState {
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>('a')
  const [viewMode, setViewMode] = useState<'single' | 'grid'>('grid')
  const [groupMode, setGroupMode] = useState<'none' | 'needs' | 'tag' | 'recent'>('recent')
  const [presentation, setPresentation] = useState<SessionPresentation>({ kind: 'builtin', mode: 'recent' })
  const [selectedId, setSelectedId] = useState<string | null>('a1')
  const [customViewList, setCustomViewList] = useState(customViews)
  const [showCustomViewEditor, setShowCustomViewEditor] = useState<string | 'new' | null>(null)
  controls.activeWorkspace = activeWorkspace
  controls.currentSelected = selectedId
  controls.workspace = setActiveWorkspace
  controls.view = setViewMode
  controls.removeOrganizerView = () =>
    setCustomViewList((views) => views.filter((view) => view.id !== showCustomViewEditor))
  controls.present = (value: string) => {
    const next = JSON.parse(value) as SessionPresentation
    controls.presentations.push(value)
    setPresentation(next)
    if (next.kind === 'builtin') setGroupMode(next.mode)
  }
  return {
    roster, activeWorkspace, selectedId, characters: [],
    presets: [], homeDir: '/synthetic', setSelectedId,
    customViews: customViewList,
    presentation,
    setPresentation: (next) => controls.present(JSON.stringify(next)),
    showCustomViewEditor, setShowCustomViewEditor,
    workspaces: [
      { id: 'a', name: 'A', order: 0, createdAt: 1 },
      { id: 'b', name: 'B', order: 1, createdAt: 1 }
    ],
    agents: [], runs: {}, setActiveRunId: noop, setEditingAgent: noop,
    editingAgent: null, activeRunId: null, showNew: false, showWorkspaces: false,
    settings: defaultSettings, viewMode, gridDensity: 'four', groupMode,
    setSetting: noop, setGridDensity: noop,
    setGroupMode: (mode) => controls.present(JSON.stringify({ kind: 'builtin', mode })),
    navWidth: 300, setNavWidth: noop, navCollapsed: false, setNavCollapsed: noop,
    collapsedGroups: new Set(), toggleGroup: noop,
    minimized: new Set(), toggleMinimize: noop, revealed: new Set(),
    groupOrder: [], reorderGroups: noop, setActiveWorkspace,
    refreshWorkspaces: noop, setShowWorkspaces: noop,
    selectSession: (id: string) => {
      controls.selected.push(id)
      setSelectedId(id)
    },
    setViewMode: (mode: string) => {
      controls.modes.push(mode)
      setViewMode(mode as 'single' | 'grid')
    },
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
if (kind === 'hook-fallback') {
  localStorage.removeItem('crew.w0.groupMode')
  localStorage.setItem('crew.w0.sessionPresentation', JSON.stringify({ kind: 'custom', viewId: 'missing' }))
  ;(window as { crew: unknown }).crew = {
    getRoster: async () => roster,
    getPresets: async () => [],
    getCharacters: async () => [],
    getHomeDir: async () => '/synthetic',
    getSettings: async () => defaultSettings,
    getWorkspaces: async () => [],
    getCustomViews: async () => [],
    getAgents: async () => [],
    onRoster: () => noop,
    onState: () => noop,
    onOutput: () => noop,
    onJump: () => noop,
    onNew: () => noop,
    onWorkspace: () => noop,
    onWorkspaces: () => noop,
    onCustomViews: () => noop,
    onOpenWorkspaces: () => noop,
    onAgents: () => noop,
    onAgentRun: () => noop
  }
}
if (kind === 'composer') {
  setEngineMode('crew')
  getPooled('composer')
  meterInput('composer', 'pending terminal input')
}

function PickerFixture() {
  const [presentation, setPresentation] = useState<SessionPresentation>({ kind: 'custom', viewId: 'focus' })
  return (
    <div className="app">
      <GroupPicker
        presentation={presentation}
        customViews={customViews}
        onChoose={(next) => {
          controls.presentations.push(JSON.stringify(next))
          setPresentation(next)
        }}
        onCreateCustomView={() => {
          controls.createdCustomViews++
        }}
        onEditCustomView={(id) => {
          controls.editedCustomViewIds.push(id)
        }}
      />
    </div>
  )
}

function HookFallbackFixture() {
  const state = useLiveCrew()
  return (
    <div className="app">
      <div className="hook-presentation">
        {state.presentation.kind === 'builtin'
          ? `builtin:${state.presentation.mode}`
          : `custom:${state.presentation.viewId}`}
      </div>
    </div>
  )
}

function ComponentsFixture() {
  return (
    <div className="app">
      <Roster
        roster={exitedRoster}
        characters={[]}
        presets={[]}
        selectedId={null}
        viewMode="single"
        onSetViewMode={noop}
        onGridRepeat={noop}
        gridDensity="four"
        collapsed={false}
        onSetCollapsed={noop}
        navWidth={300}
        onNavWidth={noop}
        groupMode="none"
        presentation={{ kind: 'custom', viewId: 'focus' }}
        customViews={customViews}
        onChoosePresentation={noop}
        onCreateCustomView={noop}
        onEditCustomView={noop}
        collapsedGroups={new Set()}
        onToggleGroup={noop}
        minimized={new Set()}
        onToggleMinimize={noop}
        revealed={new Set()}
        groupOrder={[]}
        onReorderGroups={noop}
        onSelect={noop}
        onNew={noop}
        onOpenSettings={noop}
        onBroadcast={noop}
        onAnalytics={noop}
        onOpenTracker={noop}
        agents={[]}
        runs={{}}
        onInvokeAgent={noop}
        onAddAgent={noop}
        onEditAgent={noop}
        showSpend={false}
        showCredits={false}
        budgetUsd={0}
        staleHideHours={72}
        onRestart={noop}
        onClose={noop}
        onReorder={noop}
        onSetTag={noop}
      />
      <GridView
        roster={exitedRoster}
        characters={[]}
        selectedId={null}
        gridDensity="two"
        presentation={{ kind: 'custom', viewId: 'focus' }}
        customViews={customViews}
        onChoosePresentation={noop}
        onCreateCustomView={noop}
        onEditCustomView={noop}
        groupMode="none"
        collapsedGroups={new Set()}
        onToggleGroup={noop}
        minimized={new Set()}
        onToggleMinimize={noop}
        revealed={new Set()}
        staleHideHours={72}
        minimizedAsList={false}
        enhancedTerminal={false}
        githubButton={{ show: false, opensRepo: false }}
        groupOrder={[]}
        onReorderGroups={noop}
        onSelect={noop}
        onExpand={noop}
        onClose={noop}
        onNew={noop}
        onSetViewMode={noop}
        onGridRepeat={noop}
        onOpenSettings={noop}
        onBroadcast={noop}
        onAnalytics={noop}
        onOpenTracker={noop}
        showSpend={false}
        showCredits={false}
        onReorder={noop}
        onSetTag={noop}
        onSetCharacter={noop}
        onSetColor={noop}
      />
    </div>
  )
}

function OrganizerFixture({ view }: { view: CustomView | null }) {
  const [closed, setClosed] = useState(false)
  const [currentView, setCurrentView] = useState(view)
  controls.removeOrganizerView = () => setCurrentView(null)
  if (closed) return <div className="organizer-closed">Closed</div>
  return (
    <div className="app">
      <CustomViewOrganizer
        view={currentView}
        editing={view !== null}
        roster={organizerRoster}
        workspaces={organizerWorkspaces}
        presets={organizerPresets}
        onSaved={() => setClosed(true)}
        onDeleted={() => setClosed(true)}
        onClose={() => setClosed(true)}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  kind === 'workspace' ? <WorkspaceFixture /> :
  kind === 'composer' ? <TranscriptPane sessionId="composer" enhanced /> :
  kind === 'picker' ? <PickerFixture /> :
  kind === 'hook-fallback' ? <HookFallbackFixture /> :
  kind === 'components' ? <ComponentsFixture /> :
  kind === 'organizer-new' ? <OrganizerFixture view={null} /> :
  kind === 'organizer-edit' ? <OrganizerFixture view={organizerView} /> :
  <App />
)
