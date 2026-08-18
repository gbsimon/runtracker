"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
	children,
	pendingLabel,
	className = "",
	name,
	value,
	onClick,
	title,
}: {
	children: React.ReactNode;
	pendingLabel?: string;
	className?: string;
	name?: string;
	value?: string;
	onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
	title?: string;
}) {
	const { pending } = useFormStatus();
	return (
		<button
			type="submit"
			name={name}
			value={value}
			onClick={onClick}
			title={title}
			disabled={pending}
			className={`transition disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
		>
			{pending && pendingLabel ? pendingLabel : children}
		</button>
	);
}
