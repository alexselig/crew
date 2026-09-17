import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { setTerminalRenderingActive } from './terminal/facade'
import { applyAppActivity } from './app-activity-state'

const AppActivityContext = createContext(true)

export function AppActivityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [active, setActive] = useState(true)

  useEffect(
    () =>
      window.crew.onAppActivity((next) =>
        applyAppActivity(next, [setTerminalRenderingActive], setActive)
      ),
    []
  )

  useEffect(() => {
    document.documentElement.classList.toggle('crew-inactive', !active)
  }, [active])

  return <AppActivityContext.Provider value={active}>{children}</AppActivityContext.Provider>
}

export function useAppActivity(): boolean {
  return useContext(AppActivityContext)
}
