// Generated from the five map fixtures (.local/map-fixtures, throwaway projects with an EXPECTED.md each). Do not edit by hand.
// `files` and `manifests` are the exact output of the core's `project_inventory` for each fixture (names only, Amendment 1);
// `scripts` are the TS/JS files with the specifiers a `project_imports` scan reports (derived from the sources).
export interface MapFixtureData {
  readonly files: readonly string[];
  readonly manifests: readonly { readonly path: string; readonly kind: 'npm' | 'python' | 'go' | 'rust' | 'compose' | 'prisma' | 'other'; readonly facts: Readonly<Record<string, readonly string[]>> }[];
  readonly scripts: readonly { readonly path: string; readonly specifiers: readonly string[] }[];
}

export const MAP_FIXTURES: Readonly<Record<string, MapFixtureData>> = {
  "django-shop": {
    "files": [
      ".env.example",
      "EXPECTED.md",
      "README.md",
      "accounts/__init__.py",
      "accounts/models.py",
      "accounts/urls.py",
      "accounts/views.py",
      "config/__init__.py",
      "config/settings.py",
      "config/urls.py",
      "config/wsgi.py",
      "manage.py",
      "pytest.ini",
      "requirements-dev.txt",
      "requirements.txt",
      "shop/__init__.py",
      "shop/admin.py",
      "shop/apps.py",
      "shop/migrations/0001_initial.py",
      "shop/migrations/__init__.py",
      "shop/models.py",
      "shop/tests/test_views.py",
      "shop/urls.py",
      "shop/views.py",
      "static/css/site.css",
      "templates/accounts/profile.html",
      "templates/base.html",
      "templates/shop/product_list.html"
    ],
    "manifests": [
      {
        "path": "requirements-dev.txt",
        "kind": "python",
        "facts": {
          "packages": [
            "pytest",
            "pytest-django"
          ]
        }
      },
      {
        "path": "requirements.txt",
        "kind": "python",
        "facts": {
          "packages": [
            "Django",
            "psycopg",
            "gunicorn",
            "whitenoise"
          ]
        }
      }
    ],
    "scripts": []
  },
  "express-react": {
    "files": [
      ".env.example",
      "EXPECTED.md",
      "README.md",
      "client/index.html",
      "client/src/App.jsx",
      "client/src/api/client.js",
      "client/src/components/OrderList.jsx",
      "client/src/main.jsx",
      "client/vite.config.js",
      "jobs/connection.js",
      "jobs/handlers/sendReceipt.js",
      "jobs/queue.js",
      "jobs/worker.js",
      "migrations/001_create_users.sql",
      "migrations/002_create_orders.sql",
      "migrations/run.js",
      "package.json",
      "server/controllers/ordersController.js",
      "server/controllers/usersController.js",
      "server/db.js",
      "server/index.js",
      "server/middleware/auth.js",
      "server/middleware/errorHandler.js",
      "server/routes/orders.js",
      "server/routes/users.js",
      "server/services/orderService.js",
      "server/services/userService.js",
      "tests/orders.test.js"
    ],
    "manifests": [
      {
        "path": "package.json",
        "kind": "npm",
        "facts": {
          "dependencies": [
            "express",
            "pg",
            "bullmq",
            "ioredis",
            "cors"
          ],
          "devDependencies": [
            "vite",
            "react",
            "react-dom",
            "@vitejs/plugin-react"
          ],
          "scripts": [
            "dev:server",
            "dev:client",
            "worker",
            "migrate",
            "test"
          ]
        }
      }
    ],
    "scripts": [
      {
        "path": "client/src/App.jsx",
        "specifiers": [
          "react",
          "./api/client.js",
          "./components/OrderList.jsx"
        ]
      },
      {
        "path": "client/src/api/client.js",
        "specifiers": []
      },
      {
        "path": "client/src/components/OrderList.jsx",
        "specifiers": []
      },
      {
        "path": "client/src/main.jsx",
        "specifiers": [
          "react",
          "react-dom/client",
          "./App.jsx"
        ]
      },
      {
        "path": "client/vite.config.js",
        "specifiers": [
          "vite",
          "@vitejs/plugin-react"
        ]
      },
      {
        "path": "jobs/connection.js",
        "specifiers": [
          "ioredis"
        ]
      },
      {
        "path": "jobs/handlers/sendReceipt.js",
        "specifiers": [
          "../../server/db.js"
        ]
      },
      {
        "path": "jobs/queue.js",
        "specifiers": [
          "bullmq",
          "./connection.js"
        ]
      },
      {
        "path": "jobs/worker.js",
        "specifiers": [
          "bullmq",
          "./connection.js",
          "./handlers/sendReceipt.js"
        ]
      },
      {
        "path": "migrations/run.js",
        "specifiers": [
          "node:fs/promises",
          "../server/db.js"
        ]
      },
      {
        "path": "server/controllers/ordersController.js",
        "specifiers": [
          "../services/orderService.js"
        ]
      },
      {
        "path": "server/controllers/usersController.js",
        "specifiers": [
          "../services/userService.js"
        ]
      },
      {
        "path": "server/db.js",
        "specifiers": [
          "pg"
        ]
      },
      {
        "path": "server/index.js",
        "specifiers": [
          "express",
          "cors",
          "./routes/users.js",
          "./routes/orders.js",
          "./middleware/errorHandler.js"
        ]
      },
      {
        "path": "server/middleware/auth.js",
        "specifiers": []
      },
      {
        "path": "server/middleware/errorHandler.js",
        "specifiers": []
      },
      {
        "path": "server/routes/orders.js",
        "specifiers": [
          "express",
          "../controllers/ordersController.js",
          "../middleware/auth.js"
        ]
      },
      {
        "path": "server/routes/users.js",
        "specifiers": [
          "express",
          "../controllers/usersController.js"
        ]
      },
      {
        "path": "server/services/orderService.js",
        "specifiers": [
          "../db.js",
          "../../jobs/queue.js"
        ]
      },
      {
        "path": "server/services/userService.js",
        "specifiers": [
          "../db.js"
        ]
      },
      {
        "path": "tests/orders.test.js",
        "specifiers": [
          "node:test",
          "node:assert",
          "../server/middleware/auth.js"
        ]
      }
    ]
  },
  "fastapi-sqlalchemy": {
    "files": [
      ".env.example",
      "Dockerfile",
      "EXPECTED.md",
      "README.md",
      "alembic.ini",
      "alembic/env.py",
      "alembic/versions/0001_create_users.py",
      "alembic/versions/0002_create_items.py",
      "app/__init__.py",
      "app/config.py",
      "app/database.py",
      "app/main.py",
      "app/models/__init__.py",
      "app/models/item.py",
      "app/models/user.py",
      "app/routers/__init__.py",
      "app/routers/health.py",
      "app/routers/items.py",
      "app/routers/users.py",
      "app/schemas.py",
      "pyproject.toml",
      "tests/conftest.py",
      "tests/test_health.py"
    ],
    "manifests": [
      {
        "path": "pyproject.toml",
        "kind": "python",
        "facts": {
          "packages": [
            "fastapi",
            "uvicorn",
            "sqlalchemy",
            "alembic",
            "psycopg",
            "pydantic-settings",
            "pytest",
            "httpx"
          ]
        }
      }
    ],
    "scripts": []
  },
  "go-service": {
    "files": [
      ".env.example",
      "Dockerfile",
      "EXPECTED.md",
      "Makefile",
      "README.md",
      "cmd/api/main.go",
      "cmd/migrate/main.go",
      "docker-compose.yml",
      "go.mod",
      "internal/config/config.go",
      "internal/handlers/health.go",
      "internal/handlers/orders.go",
      "internal/handlers/orders_test.go",
      "internal/handlers/router.go",
      "internal/store/orders.go",
      "internal/store/store.go",
      "migrations/0001_create_orders.down.sql",
      "migrations/0001_create_orders.up.sql",
      "migrations/0002_add_status.down.sql",
      "migrations/0002_add_status.up.sql"
    ],
    "manifests": [
      {
        "path": "docker-compose.yml",
        "kind": "compose",
        "facts": {
          "images": [
            "postgres"
          ],
          "services": [
            "api",
            "postgres"
          ]
        }
      },
      {
        "path": "go.mod",
        "kind": "go",
        "facts": {
          "module": [
            "example.com/orders"
          ],
          "require": [
            "github.com/go-chi/chi/v5",
            "github.com/jackc/pgx/v5"
          ]
        }
      }
    ],
    "scripts": []
  },
  "next-prisma-monorepo": {
    "files": [
      ".env.example",
      "EXPECTED.md",
      "README.md",
      "apps/web/app/api/health/route.ts",
      "apps/web/app/api/orders/route.ts",
      "apps/web/app/api/users/route.ts",
      "apps/web/app/dashboard/page.tsx",
      "apps/web/app/globals.css",
      "apps/web/app/layout.tsx",
      "apps/web/app/page.tsx",
      "apps/web/components/Header.tsx",
      "apps/web/components/OrderTable.tsx",
      "apps/web/lib/auth.ts",
      "apps/web/lib/db.ts",
      "apps/web/lib/format.ts",
      "apps/web/lib/orders.ts",
      "apps/web/lib/validate.ts",
      "apps/web/next.config.mjs",
      "apps/web/package.json",
      "apps/web/tsconfig.json",
      "docker-compose.yml",
      "package.json",
      "packages/db/package.json",
      "packages/db/prisma/migrations/0001_init/migration.sql",
      "packages/db/prisma/schema.prisma",
      "packages/db/src/client.ts",
      "packages/db/src/index.ts",
      "packages/ui/package.json",
      "packages/ui/src/Button.tsx",
      "packages/ui/src/Card.tsx",
      "packages/ui/src/index.tsx",
      "tsconfig.base.json"
    ],
    "manifests": [
      {
        "path": "apps/web/package.json",
        "kind": "npm",
        "facts": {
          "dependencies": [
            "next",
            "react",
            "react-dom",
            "@acme/db",
            "@acme/ui",
            "zod"
          ],
          "devDependencies": [
            "@types/react",
            "typescript"
          ],
          "scripts": [
            "dev",
            "build",
            "start",
            "lint"
          ]
        }
      },
      {
        "path": "docker-compose.yml",
        "kind": "compose",
        "facts": {
          "images": [
            "postgres",
            "redis"
          ],
          "services": [
            "postgres",
            "redis"
          ]
        }
      },
      {
        "path": "package.json",
        "kind": "npm",
        "facts": {
          "devDependencies": [
            "typescript"
          ],
          "scripts": [
            "dev",
            "build",
            "db:migrate"
          ],
          "workspaces": [
            "apps/*",
            "packages/*"
          ]
        }
      },
      {
        "path": "packages/db/package.json",
        "kind": "npm",
        "facts": {
          "dependencies": [
            "@prisma/client"
          ],
          "devDependencies": [
            "prisma"
          ],
          "scripts": [
            "migrate",
            "generate"
          ]
        }
      },
      {
        "path": "packages/db/prisma/schema.prisma",
        "kind": "prisma",
        "facts": {
          "models": [
            "User",
            "Order"
          ],
          "provider": [
            "postgresql"
          ]
        }
      },
      {
        "path": "packages/ui/package.json",
        "kind": "npm",
        "facts": {
          "peerDependencies": [
            "react"
          ]
        }
      }
    ],
    "scripts": [
      {
        "path": "apps/web/app/api/health/route.ts",
        "specifiers": []
      },
      {
        "path": "apps/web/app/api/orders/route.ts",
        "specifiers": [
          "../../../lib/auth",
          "../../../lib/orders"
        ]
      },
      {
        "path": "apps/web/app/api/users/route.ts",
        "specifiers": [
          "../../../lib/db",
          "../../../lib/auth",
          "../../../lib/validate"
        ]
      },
      {
        "path": "apps/web/app/dashboard/page.tsx",
        "specifiers": [
          "../../components/OrderTable",
          "../../lib/orders"
        ]
      },
      {
        "path": "apps/web/app/layout.tsx",
        "specifiers": [
          "react",
          "../components/Header",
          "./globals.css"
        ]
      },
      {
        "path": "apps/web/app/page.tsx",
        "specifiers": [
          "next/link"
        ]
      },
      {
        "path": "apps/web/components/Header.tsx",
        "specifiers": [
          "@acme/ui"
        ]
      },
      {
        "path": "apps/web/components/OrderTable.tsx",
        "specifiers": [
          "@acme/ui",
          "../lib/format"
        ]
      },
      {
        "path": "apps/web/lib/auth.ts",
        "specifiers": [
          "next/headers"
        ]
      },
      {
        "path": "apps/web/lib/db.ts",
        "specifiers": [
          "@acme/db"
        ]
      },
      {
        "path": "apps/web/lib/format.ts",
        "specifiers": []
      },
      {
        "path": "apps/web/lib/orders.ts",
        "specifiers": [
          "./db"
        ]
      },
      {
        "path": "apps/web/lib/validate.ts",
        "specifiers": [
          "zod"
        ]
      },
      {
        "path": "apps/web/next.config.mjs",
        "specifiers": [
          "next"
        ]
      },
      {
        "path": "packages/db/src/client.ts",
        "specifiers": [
          "@prisma/client"
        ]
      },
      {
        "path": "packages/db/src/index.ts",
        "specifiers": [
          "@prisma/client",
          "./client"
        ]
      },
      {
        "path": "packages/ui/src/Button.tsx",
        "specifiers": [
          "react"
        ]
      },
      {
        "path": "packages/ui/src/Card.tsx",
        "specifiers": [
          "react"
        ]
      },
      {
        "path": "packages/ui/src/index.tsx",
        "specifiers": [
          "./Button",
          "./Card"
        ]
      }
    ]
  }
};
