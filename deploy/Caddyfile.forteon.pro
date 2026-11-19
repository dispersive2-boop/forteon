# ==========================================================================
# ForteOn · фрагмент конфигурации Caddy для forteon.pro
#
# Вставить этот блок в C:\home_agent\caddy\Caddyfile ПОСЛЕ глобального блока
# { ... } и рядом с существующим сайтом rin-ai.pro.
#
# Схема:
#   https://forteon.pro/          -> 127.0.0.1:8080  (Next.js frontend)
#   https://forteon.pro/api/*     -> 127.0.0.1:8081  (FastAPI backend)
#   https://forteon.pro/health    -> 127.0.0.1:8081/health
#
# Ничего общего с AI-агентом (rin-ai.pro -> :3000) — порты не пересекаются.
# ==========================================================================

forteon.pro, www.forteon.pro {
	encode zstd gzip

	# --- API: FastAPI на 8081 ---
	@api path /api/* /health /api-docs*
	handle @api {
		reverse_proxy 127.0.0.1:8081 {
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-Proto {scheme}
			transport http {
				read_timeout 120s
				write_timeout 120s
				keepalive 90s
			}
		}
	}

	# --- Статика Next.js: хешированные бандлы кешируем надолго ---
	@nextimmutable path /_next/static/*
	header @nextimmutable Cache-Control "public, max-age=31536000, immutable"

	# --- Всё остальное: Next.js frontend на 8080 ---
	handle {
		reverse_proxy 127.0.0.1:8080 {
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-Proto {scheme}
			transport http {
				keepalive 90s
			}
		}
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	log {
		output file C:\home_agent\caddy\forteon-access.log {
			roll_size 20mb
			roll_keep 5
		}
		format json
		level WARN
	}
}
