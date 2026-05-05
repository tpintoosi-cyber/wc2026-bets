// Structured logger for the WC2026 app
// Writes to console with timestamps and levels
// In the admin sync log, messages are accumulated and shown in the UI

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug'

interface LogEntry {
  level: LogLevel
  message: string
  timestamp: string
  data?: unknown
}

const ICONS: Record<LogLevel, string> = {
  info:    'ℹ️',
  success: '✅',
  warn:    '⚠️',
  error:   '❌',
  debug:   '🔍',
}

function format(level: LogLevel, message: string, data?: unknown): LogEntry {
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    data,
  }
}

function print(entry: LogEntry) {
  const prefix = `[${entry.timestamp.slice(11, 19)}] ${ICONS[entry.level]}`
  if (entry.level === 'error') {
    console.error(prefix, entry.message, entry.data ?? '')
  } else if (entry.level === 'warn') {
    console.warn(prefix, entry.message, entry.data ?? '')
  } else if (entry.level === 'debug') {
    console.debug(prefix, entry.message, entry.data ?? '')
  } else {
    console.log(prefix, entry.message, entry.data ?? '')
  }
}

export const logger = {
  info:    (msg: string, data?: unknown) => { const e = format('info', msg, data);    print(e); return e },
  success: (msg: string, data?: unknown) => { const e = format('success', msg, data); print(e); return e },
  warn:    (msg: string, data?: unknown) => { const e = format('warn', msg, data);    print(e); return e },
  error:   (msg: string, data?: unknown) => { const e = format('error', msg, data);   print(e); return e },
  debug:   (msg: string, data?: unknown) => { const e = format('debug', msg, data);   print(e); return e },

  // Group multiple logs under a named operation
  group: (name: string) => {
    console.group(`🔧 ${name}`)
    return { end: () => console.groupEnd() }
  },
}
