<script lang="ts">
	import type { Snippet } from 'svelte';

	let { src, alt, scale = 2, maxWidth = 0, maxHeight = 0, contain = false, children }: { src: string; alt: string; scale?: number; maxWidth?: number; maxHeight?: number; contain?: boolean; children: Snippet } = $props();

	let hovering = $state(false);
	let mouseX = $state(0);
	let mouseY = $state(0);
	let portalTarget = $state<HTMLElement | null>(null);

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

	$effect(() => {
		if (hovering && src) {
			if (!portalTarget) {
				portalTarget = document.createElement('div');
				document.body.appendChild(portalTarget);
			}

			const width = maxWidth || 244 * scale;
			const height = maxHeight || 340 * scale;
			let x = mouseX + 20;
			let y = mouseY - height / 2;
			if (x + width > window.innerWidth - 10) x = mouseX - width - 20;
			if (y < 10) y = 10;
			if (y + height > window.innerHeight - 10) y = window.innerHeight - height - 10;

			const fit = contain ? 'contain' : 'cover';
			const bg = contain ? 'background:#111;' : '';
			portalTarget.style.cssText = `position:fixed;z-index:9999;pointer-events:none;left:${x}px;top:${y}px;width:${width}px;height:${height}px;border-radius:0.5rem;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);${bg}`;
			portalTarget.innerHTML = `<img src="${src}" alt="${alt}" style="width:100%;height:100%;object-fit:${fit};" />`;
		} else if (portalTarget) {
			portalTarget.remove();
			portalTarget = null;
		}
	});

	$effect(() => {
		return () => {
			portalTarget?.remove();
		};
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	onmouseenter={onEnter}
	onmouseleave={onLeave}
	onmousemove={onMove}
>
	{@render children()}
</div>
