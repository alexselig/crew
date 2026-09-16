export async function waitUntil(fn, desc, timeout = 10000, interval = 150) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try {
      last = await fn()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timeout waiting for: ${desc} (last=${JSON.stringify(last)})`)
}

export function attachRendererErrorCapture(page, rendererErrors) {
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/Failed to load resource/i.test(text) && /404/.test(text)) return
    if (/\bmain\.tsx\b|\.map\b/i.test(text)) return
    if (/Content Security Policy/i.test(text)) return
    rendererErrors.push(text)
  })
}

async function sessionOrder(page, selector) {
  return page.locator(selector).evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute('data-session-id'))
      .filter(Boolean)
  )
}

async function rosterIds(page) {
  return page.evaluate(async () => (await window.crew.getRoster()).map((session) => session.id))
}

export async function runCustomViewsRelaunchScenario({ page, preparePage, relaunchPage }) {
  const checks = []
  if (preparePage) page = await preparePage(page)

  const queueSessions = await page.evaluate(async () => {
    const labels = ['Queue Alpha', 'Queue Beta', 'Queue Gamma']
    const sessions = []
    for (const label of labels) {
      sessions.push(
        await window.crew.createSession({
          presetId: null,
          command: 'node',
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: '/work/custom-views',
          label
        })
      )
    }
    return sessions.map((session) => ({ id: session.id, label: session.label }))
  })
  const [queueAlpha, queueBeta, queueGamma] = queueSessions

  await waitUntil(async () => (await page.evaluate(() => window.crew.getRoster().then((roster) => roster.length))) === 3, 'three sessions available')
  checks.push('created three sessions for the custom-view journey')

  await page.locator('.roster__toolbar [title="Choose session view"]').click()
  await page.getByRole('menuitem', { name: 'New custom view' }).click()
  await page.getByLabel('View name').fill('Release queue')
  await page.getByRole('searchbox', { name: 'Search all sessions' }).fill(queueAlpha.label)
  await page
    .locator(
      `.custom-view-organizer__available-card[data-session-id="${queueAlpha.id}"] [data-drag-handle]`
    )
    .dragTo(page.locator('.custom-view-organizer__drop-line[data-index="0"]'))
  await page.getByRole('searchbox', { name: 'Search all sessions' }).fill(queueBeta.label)
  await page
    .locator(
      `.custom-view-organizer__available-card[data-session-id="${queueBeta.id}"] [data-drag-handle]`
    )
    .dragTo(page.locator('.custom-view-organizer__drop-line[data-index="0"]'))

  const rankedBeforeSave = await sessionOrder(page, '.custom-view-organizer__ranked-card')
  if (JSON.stringify(rankedBeforeSave) !== JSON.stringify([queueBeta.id, queueAlpha.id])) {
    throw new Error(`ranked order before save was ${JSON.stringify(rankedBeforeSave)}`)
  }
  checks.push('dragging a second session to rank 1 moves the first to rank 2')

  await page.getByRole('button', { name: 'Save view' }).click()
  await page.waitForSelector('.custom-view-organizer', { state: 'detached', timeout: 5000 })
  const expectedQueueOrder = [queueBeta.id, queueAlpha.id, queueGamma.id]
  await page.waitForFunction(
    (expected) =>
      JSON.stringify(
        Array.from(document.querySelectorAll('.roster__list .card'))
          .map((element) => element.getAttribute('data-session-id'))
          .filter(Boolean)
      ) === JSON.stringify(expected),
    expectedQueueOrder
  )
  checks.push('saved custom view orders the roster')

  await page.locator('.view-toggle button[title="Grid view"]').click()
  await page.waitForSelector('.grid .tile', { timeout: 5000 })
  const rosterQueueOrder = await sessionOrder(page, '.roster__list .card')
  const gridQueueOrder = await sessionOrder(page, '.grid .tile')
  if (JSON.stringify(rosterQueueOrder) !== JSON.stringify(expectedQueueOrder)) {
    throw new Error(`roster order mismatch: ${JSON.stringify(rosterQueueOrder)}`)
  }
  if (JSON.stringify(gridQueueOrder) !== JSON.stringify(expectedQueueOrder)) {
    throw new Error(`grid order mismatch: ${JSON.stringify(gridQueueOrder)}`)
  }
  checks.push('roster and grid use the same custom-view order')

  page = await relaunchPage(page)

  await waitUntil(async () => (await page.evaluate(() => window.crew.getRoster().then((roster) => roster.length))) === 3, 'three sessions restored after relaunch')
  const reopenedOrder = await sessionOrder(page, '.roster__list .card')
  if (JSON.stringify(reopenedOrder) !== JSON.stringify(expectedQueueOrder)) {
    throw new Error(`restored roster order mismatch: ${JSON.stringify(reopenedOrder)}`)
  }

  await page.locator('.roster__toolbar [title="Choose session view"]').click()
  const persistedView = page.getByRole('menuitemradio', { name: /Release queue/ })
  if ((await persistedView.getAttribute('aria-checked')) !== 'true') {
    throw new Error('Release queue was not selected after relaunch')
  }
  checks.push('custom-view selection and order persist across relaunch')

  await page.getByRole('button', { name: 'Edit view' }).click()
  await page
    .locator(
      `.custom-view-organizer__ranked-card[data-session-id="${queueAlpha.id}"] [data-drag-handle]`
    )
    .dragTo(page.locator('.custom-view-organizer__available-drop'))
  await page.getByRole('button', { name: 'Save view' }).click()
  await page.waitForSelector('.custom-view-organizer', { state: 'detached', timeout: 5000 })
  const persistedItems = await page.evaluate(async () => {
    const view = (await window.crew.getCustomViews()).find((item) => item.name === 'Release queue')
    return view?.items.map((item) => item.sessionId) ?? []
  })
  if (JSON.stringify(persistedItems) !== JSON.stringify([queueBeta.id])) {
    throw new Error(`saved ranked items after removal were ${JSON.stringify(persistedItems)}`)
  }
  checks.push('dragging a ranked session back left removes it from the saved view')

  const removedOrder = [queueBeta.id, queueGamma.id, queueAlpha.id]
  await page.waitForFunction(
    (expected) =>
      JSON.stringify(
        Array.from(document.querySelectorAll('.roster__list .card'))
          .map((element) => element.getAttribute('data-session-id'))
          .filter(Boolean)
      ) === JSON.stringify(expected),
    removedOrder
  )

  await page.locator('.roster__toolbar [title="Choose session view"]').click()
  await page.getByRole('button', { name: 'Edit view' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete view' }).click()
  await page.waitForSelector('.custom-view-organizer', { state: 'detached', timeout: 5000 })
  await page.locator('.roster__toolbar [title="Choose session view"]').click()
  const recentFallback = page.locator('[role="menuitemradio"]').filter({ hasText: 'By recent' })
  if ((await recentFallback.first().getAttribute('aria-checked')) !== 'true') {
    throw new Error('deleting the active custom view did not fall back to Recent')
  }
  if ((await page.locator('.group-menu__label', { hasText: 'Release queue' }).count()) !== 0) {
    throw new Error('Release queue still appeared after delete')
  }
  const survivingIds = (await rosterIds(page)).slice().sort()
  const expectedSurvivors = queueSessions.map((session) => session.id).sort()
  if (JSON.stringify(survivingIds) !== JSON.stringify(expectedSurvivors)) {
    throw new Error(`sessions changed when deleting the view: ${JSON.stringify(survivingIds)}`)
  }
  checks.push('deleting the active view falls back to Recent and keeps every session')

  await page.evaluate(async (ids) => {
    for (const id of ids) await window.crew.closeSession(id)
  }, queueSessions.map((session) => session.id))
  await waitUntil(async () => (await page.evaluate(() => window.crew.getRoster().then((roster) => roster.length))) === 0, 'scenario cleanup closes every session')

  return { checks }
}
