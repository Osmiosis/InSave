// Account affordance for the home header. Thin DOM wiring over auth-client
// (testable logic lives there). Signed out: a "Sign in" button. Signed in:
// the account name + "Sign out". The anonymous capture flow is untouched.
import { getSession, signInGoogle, signOut } from "./auth-client";

export async function renderAccount(el: HTMLElement): Promise<void> {
  const session = await getSession();
  el.textContent = "";
  if (session) {
    const who = document.createElement("span");
    who.className = "account-who";
    who.textContent = session.user.name || session.user.email;
    const out = document.createElement("button");
    out.textContent = "Sign out";
    out.addEventListener("click", async () => {
      await signOut();
      window.location.reload();
    });
    el.appendChild(who);
    el.appendChild(out);
  } else {
    const signIn = document.createElement("button");
    signIn.textContent = "Sign in";
    signIn.addEventListener("click", () => {
      void signInGoogle(window.location.pathname);
    });
    el.appendChild(signIn);
  }
}

const mount = document.getElementById("account");
if (mount) void renderAccount(mount);
