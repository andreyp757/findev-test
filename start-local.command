#!/bin/bash
# Назначение файла: запуск проекта одной командой или двойным кликом в Finder.
# Подключает доступные инструменты, проверяет зависимости и запускает стандартный npm start.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

fail() {
  printf '\nОшибка: %s\nПодробная установка: %s/README.md\n' "$1" "$PROJECT_DIR" >&2
  exit 1
}

# Порт можно выбрать явно; без аргументов сохраняем стандартный запуск.
APP_PORT=4200
if [[ $# -gt 0 ]]; then
  [[ $# -eq 2 && "$1" == "--port" ]] || fail 'Использование: ./start-local.command [--port 4300]'
  APP_PORT="$2"
fi
[[ "$APP_PORT" =~ ^[0-9]{1,5}$ ]] || fail 'Порт должен быть целым числом от 1 до 65535.'
APP_PORT=$((10#$APP_PORT))
(( APP_PORT >= 1 && APP_PORT <= 65535 )) || fail 'Порт должен быть от 1 до 65535.'

# Если временное окружение этой машины сохранилось, используем подготовленный Node.
if [[ -x /tmp/findev-node/node_modules/.bin/node ]]; then
  export PATH="/tmp/findev-node/node_modules/.bin:$PATH"
fi

# Сначала учитываем выбранный пользователем Cargo home или обычную установку rustup.
if [[ -d "${CARGO_HOME:-$HOME/.cargo}/bin" ]]; then
  export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
fi

# Если инструментов нет в PATH, подключаем подготовленный Rust; настройки оболочки не меняем.
if ! command -v cargo >/dev/null 2>&1 || ! command -v wasm-pack >/dev/null 2>&1; then
  if [[ -z "${CARGO_HOME:-}" && -z "${RUSTUP_HOME:-}" &&
        -x /tmp/findev-cargo/bin/cargo && -x /tmp/findev-cargo/bin/wasm-pack &&
        -d /tmp/findev-rustup ]]; then
    export CARGO_HOME=/tmp/findev-cargo
    export RUSTUP_HOME=/tmp/findev-rustup
    export PATH="/tmp/findev-cargo/bin:$PATH"
    printf 'Подключено подготовленное окружение Rust из /tmp.\n'
  fi
fi

for tool in node npm cargo wasm-pack; do
  command -v "$tool" >/dev/null 2>&1 || fail "Не найден $tool. Установи необходимые инструменты по README."
done

# Проверяем не только наличие cargo, но и доступность toolchain проекта.
cargo metadata --manifest-path wasm/market-producer/Cargo.toml --no-deps --format-version 1 >/dev/null || fail 'Cargo найден, но Rust проекта недоступен. Проверь rustup show.'

node - <<'JS' || fail 'Версия Node не поддерживается. Нужна Node 22.22.3+, 24.15+ или 26.x.'
const [major, minor, patch] = process.versions.node.split('.').map(Number);
const supported = (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) ||
  (major === 24 && minor >= 15) || major === 26;
if (!supported) process.exit(1);
JS

# npm ci выполняется при первом запуске скрипта и при изменении зависимостей или ABI Node.
# Маркер лежит в игнорируемом node_modules и не попадает в репозиторий.
DEPENDENCY_KEY="$(node - <<'JS'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const hash = createHash('sha256');
for (const file of ['package.json', 'package-lock.json']) hash.update(readFileSync(file));
hash.update(JSON.stringify([process.versions.modules, process.platform, process.arch]));
process.stdout.write(hash.digest('hex'));
JS
)"
DEPENDENCY_STAMP=node_modules/.findev-dependencies.sha256
if [[ ! -x node_modules/.bin/ng || ! -r "$DEPENDENCY_STAMP" ||
      "$(cat "$DEPENDENCY_STAMP" 2>/dev/null || true)" != "$DEPENDENCY_KEY" ]]; then
  printf '\nУстанавливаю зависимости проекта…\n'
  npm ci
  printf '%s\n' "$DEPENDENCY_KEY" > "$DEPENDENCY_STAMP"
else
  printf 'Зависимости уже установлены и актуальны.\n'
fi

# Проверяем именно выбранный порт, чтобы Angular не сменил адрес незаметно.
node - "$APP_PORT" <<'JS' || fail "Порт $APP_PORT недоступен. Возможно, проект уже запущен: http://127.0.0.1:$APP_PORT/"
const { createServer } = require('node:net');
const server = createServer();
server.once('error', () => process.exit(1));
server.listen(Number(process.argv[2]), '127.0.0.1', () => server.close());
JS

printf '\nЗапускаю FinDev: http://127.0.0.1:%s/\nДля остановки нажми Ctrl+C.\n\n' "$APP_PORT"
exec npm start -- --port "$APP_PORT"
