import type { NextAuthOptions } from "next-auth"

export const authConfig:Partial<NextAuthOptions> = {
  pages: {
    signIn: "/login",
  },
  providers: [], // Leave this empty
}