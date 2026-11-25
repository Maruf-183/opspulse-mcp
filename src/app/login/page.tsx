import Link from "next/link";

/** Sign-in page. Errors from the GitHub callback arrive as ?error=… */
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Sign in to OpsPulse</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Something went wrong signing you in. Please try again.</p>
        <a href="/api/auth/github?next=/dashboard" className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-slate-900 text-sm font-semibold text-white dark:bg-white dark:text-slate-900">
          Sign in with GitHub
        </a>
        <Link href="/dashboard" className="mt-3 block text-sm text-slate-500 underline">Back to the dashboard</Link>
      </div>
    </main>
  );
}
