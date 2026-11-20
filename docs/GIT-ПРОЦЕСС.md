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

## 6. Подключение GitHub

Репозиторий локальный, remote ещё нет. Нужен пустой репозиторий на GitHub
(**без** README и `.gitignore` — иначе первый push конфликтует).

Создать репозиторий можно так:

```bat
:: через GitHub CLI, если установлен
gh auth login
gh repo create forteon --private --source=. --remote=origin --push
```

Без `gh` — вручную в браузере, затем:

```bat
cd сц\forteon
git remote add origin https://github.com/<аккаунт>/forteon.git
git push -u origin main
git push -u origin develop
```

Пароль от аккаунта не подходит: нужен **Personal Access Token**
(Settings → Developer settings → Personal access tokens → Fine-grained tokens),
права — `Contents: Read and write` на этот репозиторий.
Токен вводится вместо пароля и **не** сохраняется в файлах проекта.

Проверка:

```bat
git remote -v
git branch -vv
git log --oneline --graph --decorate --all
```

## 7. Защита веток на GitHub

После появления remote включить в Settings → Branches:

- `main`: запретить прямой push, требовать PR, требовать зелёный CI;
- `develop`: запретить прямой push, требовать PR.

CI уже описан в [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) и запускается
сам на push в `main`/`develop` и на каждый PR: `pytest`, `tsc`, проверка на секреты
в индексе и формата сообщений коммитов.

## 8. Если что-то пошло не так

| Ситуация | Команда |
|---|---|
| Случайно закоммитил не тот файл, коммит не отправлен | `git reset --soft HEAD~1` и пересобрать коммит |
| Надо отменить правки в файле | `git restore путь/к/файлу` |
| Нужно спрятать незакоммиченное перед переключением | `git stash` → `git stash pop` |
| Ветку уже отправили и надо откатить | `git revert <sha>` (не `reset`) |
| Секрет попал в коммит | отозвать ключ, затем `git filter-repo` — удаления файла следующим коммитом **недостаточно** |
