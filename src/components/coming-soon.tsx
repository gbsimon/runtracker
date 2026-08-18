export function ComingSoon({ icon, title, description }: { icon: string; title: string; description: string }) {
	return (
		<section className="fade-in">
			<h2 className="mb-4 text-lg font-bold text-white">{title}</h2>
			<div className="card glow p-8 text-center">
				<div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600/20 text-2xl">
					{icon}
				</div>
				<p className="text-sm text-gray-400">{description}</p>
			</div>
		</section>
	);
}
