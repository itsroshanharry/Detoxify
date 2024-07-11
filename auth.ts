import NextAuth, { User, Account, Profile, Session, NextAuthOptions } from "next-auth"
import GoogleProvider from "next-auth/providers/google"
import { connectToMongoDB } from "./lib/db"
import UserModel from "./models/userModel"
import { authConfig } from "./auth.config"
import { JWT } from "next-auth/jwt"

export const config: NextAuthOptions = {
  ...authConfig,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      authorization: {
        params: {
          scope: "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.channel-memberships.creator"
        }
      }
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET || "",
  callbacks: {
    async signIn({ user, account, profile }: { user: User, account: Account | null, profile?: Profile }) {
      if (account?.provider === "google" && profile) {
        await connectToMongoDB();
        
        try {
          let existingUser = await UserModel.findOne({ email: profile.email });
          
          if (!existingUser) {
            existingUser = await UserModel.create({
              email: profile.email,
              fullName: profile.name,
              avatar: (profile as any)?.picture,
            });
          }
          
          // Update access token
          existingUser.accessToken = account.access_token || "";
          existingUser.refreshToken = account.refresh_token || "";
          await existingUser.save();
          
          return true;
        } catch (error) {
          console.log(error);
          return false;
        }
      }
      
      return false;
    },
    async jwt({token, account}: {token:JWT; account: Account | null }) {
      if(account) {
        token.accessToken = account.access_token;
      }
      return token;
    },
    
    async session({ session, token }: {session: Session, token: any}) {
      session.accessToken = token.accessToken;
      session.refreshToken = token.refreshToken;
      return session;
    },
  },
};

export default NextAuth(config);