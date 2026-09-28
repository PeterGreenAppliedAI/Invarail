/**
 * The Python interpreter name for THIS platform. POSIX ships `python3`; Windows ships the
 * `py` launcher and `python`, and usually no `python3` at all (the Store alias aside). One
 * place decides, so the REPL, the exec allowlist default, the diagram renderer and the
 * code-gen venv agree (Windows CI, 2026-09-28).
 */
export const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

/** Every name a user may reasonably write in an exec allowlist for Python on this platform. */
export const PYTHON_ALIASES = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
