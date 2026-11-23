"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AuthUser, api, clearSession, getUser, logout } from "@/lib/api";
import { initials } from "@/lib/format";

type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  photoUrl: string | null;
  refreshPhoto: () => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({ user: null, loading: true, photoUrl: null, refreshPhoto: () => {}, signOut: async () => {} });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [photo, setPhoto] = useState<{ userId: string; url: string } | null>(null);
  const [photoRevision, setPhotoRevision] = useState(0);
  const refreshPhoto = useCallback(() => setPhotoRevision((revision) => revision + 1), []);

  const userId = user?.id;
  useEffect(() => {
    if (!userId) {
      setPhoto(null);
      return;
    }
    const controller = new AbortController();
    let url: string | null = null;
    void api<Blob>("/auth/avatar", { raw: true, signal: controller.signal }).then((blob) => {
      if (controller.signal.aborted) return;
      if (blob.size) url = URL.createObjectURL(blob);
      setPhoto(url ? { userId, url } : null);
    }).catch(() => {});
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [userId, photoRevision]);
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

  const photoUrl = photo?.userId === userId ? photo?.url ?? null : null;
  const value = useMemo(() => ({ user, loading, signOut, photoUrl, refreshPhoto }), [user, loading, signOut, photoUrl, refreshPhoto]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function UserBadge({ user }: { user: AuthUser }) {
  const { photoUrl } = useAuth();
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full text-[13px] font-semibold text-white"
        style={{ background: user.avatar_color || "var(--primary)" }}
      >
        {photoUrl ? <img src={photoUrl} alt="" className="h-full w-full object-cover" /> : initials(user.full_name)}
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
