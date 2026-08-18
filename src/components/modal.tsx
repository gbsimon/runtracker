"use client";

import { useEffect } from "react";

export function Modal({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: React.ReactNode;
}) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	return (
		<div
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		>
			<div role="dialog" aria-modal="true" aria-label={title} className="glass glow fade-in w-full max-w-md p-6">
				<div className="mb-5 flex items-center justify-between">
					<h2 className="text-lg font-bold text-white">{title}</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="text-xl leading-none text-gray-500 transition hover:text-gray-300"
					>
						&times;
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
