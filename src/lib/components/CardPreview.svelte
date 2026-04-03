<script lang="ts">
	let { src, alt, scale = 2 }: { src: string; alt: string; scale?: number } = $props();

	let hovering = $state(false);
	let mouseX = $state(0);
	let mouseY = $state(0);
	let imgEl = $state<HTMLElement>(null!);

	function onEnter() {
		hovering = true;
	}

	function onLeave() {
		hovering = false;
	}

	function onMove(e: MouseEvent) {
		mouseX = e.clientX;
		mouseY = e.clientY;
	}

	let previewStyle = $derived.by(() => {
		if (!hovering) return '';
		const width = 244 * scale;
		const height = 340 * scale;
		let x = mouseX + 20;
		let y = mouseY - height / 2;
		// Keep within viewport
		if (x + width > window.innerWidth - 10) x = mouseX - width - 20;
		if (y < 10) y = 10;
		if (y + height > window.innerHeight - 10) y = window.innerHeight - height - 10;
		return `left:${x}px;top:${y}px;width:${width}px;height:${height}px;`;
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	bind:this={imgEl}
	onmouseenter={onEnter}
	onmouseleave={onLeave}
	onmousemove={onMove}
	class="contents"
>
	<slot />
</span>

{#if hovering && src}
	<div
		class="fixed z-[100] pointer-events-none rounded-lg overflow-hidden shadow-2xl border border-[var(--color-border)]"
		style={previewStyle}
	>
		<img {src} {alt} class="w-full h-full object-cover" />
	</div>
{/if}
