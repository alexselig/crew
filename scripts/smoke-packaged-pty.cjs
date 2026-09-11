// Run with the packaged Electron and ELECTRON_RUN_AS_NODE=1; never start Crew's UI.
const path = require('node:path')
const os = require('node:os')

const archive = process.argv[2]
if (!archive || !process.versions.electron) {
  console.error('Usage: packaged-Electron smoke-packaged-pty.cjs /path/to/Resources/app.asar')
  process.exit(1)
}
const pty = require(path.join(path.resolve(archive), 'node_modules', 'node-pty'))
const windows = process.platform === 'win32'
const terminal = pty.spawn(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
  windows ? ['/d', '/c', 'echo CREW_NATIVE_PTY_OK'] : ['-c', 'printf "CREW_NATIVE_PTY_OK\\n"'],
  { name: 'xterm-color', cols: 80, rows: 24, cwd: os.tmpdir(), env: { ...process.env } })
let output = ''
const timer = setTimeout(() => {
  console.error('Packaged native PTY did not exit within 15 seconds.')
  terminal.kill()
  process.exit(1)
}, 15000)
terminal.onData(data => { output = (output + data).slice(-4096) })
terminal.onExit(({ exitCode }) => {
  setTimeout(() => {
    clearTimeout(timer)
    if (exitCode !== 0 || !output.includes('CREW_NATIVE_PTY_OK')) {
      console.error(`Packaged native PTY failed (exit ${exitCode}, marker ${output.includes('CREW_NATIVE_PTY_OK')}).`)
      process.exit(1)
    }
    console.log(`Packaged native PTY passed: Electron ${process.versions.electron}, ${process.platform}/${process.arch}.`)
    process.exit(0)
  }, 100)
})
