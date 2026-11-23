# Git-процесс ForteOn: практическая шпаргалка

Правила описаны в [`CONTRIBUTING.md`](../CONTRIBUTING.md). Здесь — только команды,
в том порядке, в котором их выполняют.

---

## 1. Ветки

В репозитории две долгоживущие ветки:

| Ветка | Что там |
|---|---|
| `main` | то, что развёрнуто на `forteon.pro` |
| `develop` | текущая интеграция; сюда вливаются фичи |

Рабочая ветка создаётся **всегда от `develop`**:

```bat
git switch develop
git pull --ff-only
git switch -c feature/task-chat-notes
```

Префиксы: `feature/`, `fix/`, `chore/`, `docs/`.
`main` и `develop` напрямую не правятся — только через merge.

## 2. Работа и коммиты

```bat
git status
git add -- путь/к/файлу
git commit
```

`git commit` без `-m` откроет редактор с шаблоном [`.gitmessage`](../.gitmessage) —
он уже подключён (`git config commit.template .gitmessage`).

Если удобнее одной строкой — тема и тело отдельными `-m`:

```bat
git commit -m "fix(tasks): не ставить «Уточнить» задачам без срока" -m "Почему: needs_review выставлялся по due_date is null." -m "Проверено: pytest 43 passed, tsc 0 ошибок."
```

Перед каждым коммитом смотреть, что именно уходит:

```bat
git diff --cached --stat
git diff --cached
```

В диффе не должно быть `.env`, `*.db`, `node_modules`, `_*.py`.

## 3. Проверки перед слиянием

```bat
cd backend  &&  python -m pytest tests -q
cd frontend &&  node node_modules/typescript/bin/tsc --noEmit
```

Обе команды должны завершиться успешно. Тесты бэкенда работают на изолированной БД
(см. [`backend/tests/conftest.py`](../backend/tests/conftest.py)) и боевых данных не касаются.

## 4. Слияние фичи в `develop`

Одна фича = один коммит в `develop`. Для этого используется squash:

```bat
git switch develop
git merge --squash feature/task-chat-notes
git commit -m "feat(planner): ..." -m "Подробности."
git branch -D feature/task-chat-notes
```

`git branch -d` здесь **не сработает**: после squash-мержа коммиты фичи не являются
предками `develop`, поэтому нужен `-D`. Это нормально и ожидаемо.

Если фича разрабатывалась долго и `develop` ушёл вперёд:

```bat
git switch feature/task-chat-notes
git fetch origin
git rebase origin/develop
```

## 5. Релиз: `develop` → `main`

```bat
git switch main
git merge --no-ff develop -m "release: v1.2.0"
git tag -a v1.2.0 -m "Версия 1.2.0: задача как чат заметок, раздел «Без срока» целиком"
git push origin main
git push origin v1.2.0
```

Тег на `main` — признак того, что именно развёрнуто.

## 6. Удалённый репозиторий (уже подключён)

Репозиторий: **https://github.com/dispersive2-boop/forteon** — **публичный**.
`origin` настроен; `main`, `develop` и тег `v1.1.0` отправлены.

Публичный он специально: ссылку можно дать внешнему инструменту (например, чату),
и он прочитает код без авторизации. Перед публикацией из истории был удалён
скриншот с реальными данными клиента, ФИО менеджера и суммами — просто убрать
файл новым коммитом недостаточно, он остаётся в истории.

Повторить связку с нуля:

```bat
winget install --id GitHub.cli --accept-package-agreements --accept-source-agreements
gh auth login --hostname github.com --git-protocol https --web
gh repo create forteon --private --description "ForteOn — AI-first CRM"
git remote add origin https://github.com/<аккаунт>/forteon.git
git push -u origin main
git push -u origin develop
git push origin v1.1.0
```

`gh auth login --web` печатает одноразовый код вида `XXXX-XXXX` и открывает
https://github.com/login/device: код вводится на странице, затем **Authorize**.
Код живёт около 15 минут; если истёк — вход надо запустить заново и взять новый код.
Пока код не подтверждён, `gh` висит в ожидании, а `gh auth status` пишет
«not logged into any GitHub hosts» — это нормальное промежуточное состояние.

Пароль от аккаунта для git не подходит: `gh` сам подставляет токен через
credential helper. Без `gh` нужен Personal Access Token
(Settings → Developer settings → Personal access tokens → Fine-grained tokens)
с правом `Contents: Read and write`; токен **не** хранится в файлах проекта.

Проверка связки:

```bat
git remote -v
git branch -vv
gh run list --limit 5
```

## 7. Защита веток на GitHub — включена

Для **приватного** репозитория branch protection требует платного плана
(`403 Upgrade to GitHub Pro`), поэтому репозиторий сделан публичным —
и защита стала доступна бесплатно.

На `main` и `develop` сейчас:

| Правило | Значение |
|---|---|
| обязательный зелёный CI | `Backend · pytest`, `Frontend · tsc`, `Hygiene · нет секретов` |
| strict | да — ветка должна быть свежей относительно `main` |
| force-push | запрещён |
| удаление ветки | запрещено |

Проверить состояние:

```bat
gh api repos/dispersive2-boop/forteon/branches/main/protection
```

Если репозиторий снова понадобится сделать приватным — защита веток отключится
вместе с возвратом на бесплатный план для приватных репозиториев.

## 7а. Что проверить перед публикацией репозитория

Публикация необратима в том смысле, что данные остаются в истории, форках и кэшах.
Обязательный минимум:

1. **Секреты.** `.env`/`.env.local` в `.gitignore`; в истории только плейсхолдеры
   (`change-me-to-a-long-random-string`, пустой `FORTEON_AI_API_KEY=`).
   Проверка: `git log --all -p -- . | findstr /i "API_KEY= SECRET_KEY= ghp_ gho_"`.
2. **Персональные данные.** Скриншоты и примеры не должны содержать имена клиентов,
   ФИО сотрудников, суммы, ИНН, телефоны, адреса. В нашем случае из истории был
   удалён `docs/screenshots/11_client_history.png` (реальный клиент, менеджер, суммы)
   через `git filter-repo --invert-paths`, после чего ветки запушены с `--force`.
3. **Тестовые данные.** Тесты должны использовать синтетические id
   (`test-client-0000-...`), а не выгрузки из боевой БД.
4. **Скрипты.** Одноразовые `_*.py` с доступами к серверам — в `.gitignore`,
   не в истории.

Удаление файла новым коммитом **не** решает проблему: он остаётся доступен
по старому хешу. Нужна перепись истории.

## 8. Если что-то пошло не так

| Ситуация | Команда |
|---|---|
| Случайно закоммитил не тот файл, коммит не отправлен | `git reset --soft HEAD~1` и пересобрать коммит |
| Надо отменить правки в файле | `git restore путь/к/файлу` |
| Нужно спрятать незакоммиченное перед переключением | `git stash` → `git stash pop` |
| Ветку уже отправили и надо откатить | `git revert <sha>` (не `reset`) |
| Секрет попал в коммит | отозвать ключ, затем `git filter-repo` — удаления файла следующим коммитом **недостаточно** |
