"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AuthUser, api, clearSession, getUser, logout } from "@/lib/api";
import { initials } from "@/lib/format";

type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({ user: null, loading: true, signOut: async () => {} });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const cached = getUser();
    if (cached) setUser(cached);

    let cancelled = false;
    api<AuthUser>("/auth/me")
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        if (!cancelled) {
          clearSession();
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user && pathname !== "/login") router.replace("/login");
    if (user && pathname === "/login") router.replace("/today");
  }, [loading, user, pathname, router]);

  const signOut = useCallback(async () => {
    await logout();
    setUser(null);
    router.replace("/login");
  }, [router]);

  const value = useMemo(() => ({ user, loading, signOut }), [user, loading, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function UserBadge({ user }: { user: AuthUser }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-white"
        style={{ background: user.avatar_color || "var(--primary)" }}
      >
        {initials(user.full_name)}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13.5px] font-semibold text-white">
          {user.full_name}
        </span>
        <span className="truncate text-[12px] text-white/55">
          {user.role === "admin" ? "Администратор" : "Менеджер"}
        </span>
      </span>
    </div>
  );
}
