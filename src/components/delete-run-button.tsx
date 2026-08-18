"use client";

import { deleteRunAction } from "@/lib/run-actions";

export function DeleteRunButton({ runId, summary }: { runId: string; summary: string }) {
	return (
		<form
			action={deleteRunAction}
			onSubmit={(event) => {
				if (!confirm(`Delete ${summary}? This cannot be undone.`)) event.preventDefault();
			}}
		>
			<input type="hidden" name="id" value={runId} />
			<button type="submit" title="Delete" className="p-1 text-gray-600 transition hover:text-red-400">
				<svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth="2"
						d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
					/>
				</svg>
			</button>
		</form>
	);
}
