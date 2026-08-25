import { useEffect, useState } from 'react'
import { Icon } from './Icon'

/**
 * A GitHub chip that appears next to the Skills button only when the session's
 * working directory has a GitHub `origin` remote. Clicking it copies the URL to
 * the clipboard and — when `opensRepo` is true — also opens the repo in the
 * browser (with a brief "Copied" confirmation). The URL is re-resolved when the
 * working dir changes and when the window regains focus, so a remote added
 * mid-session shows up without a reload.
 */
export function GithubButton({ cwd, opensRepo = true }: { cwd: string; opensRepo?: boolean }): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    const resolve = (): void => {
      window.crew
        .getGithubUrl(cwd)
        .then((u) => {
          if (!cancelled) setUrl(u)
        })
        .catch(() => {
          if (!cancelled) setUrl(null)
        })
    }
    resolve()
    window.addEventListener('focus', resolve)
    return () => {
      cancelled = true
      window.removeEventListener('focus', resolve)
    }
  }, [cwd])

  if (!url) return null

  const activate = (): void => {
    const link = url
    if (opensRepo) void window.crew.openExternal(link)
    void navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        /* clipboard may be unavailable; the repo still opens when enabled */
      })
  }

  const action = opensRepo
    ? `Open ${url} in your browser and copy the URL`
    : `Copy the repo URL (${url})`
  return (
    <button
      type="button"
      className={`btn btn--outline github-btn ${copied ? 'is-copied' : ''}`}
      onClick={activate}
      title={action}
      aria-label={opensRepo ? 'Open GitHub repository and copy its URL' : 'Copy GitHub repository URL'}
    >
      <Icon name={copied ? 'check' : 'github'} size={13} />
      {copied ? 'Copied' : 'GitHub'}
    </button>
  )
}
