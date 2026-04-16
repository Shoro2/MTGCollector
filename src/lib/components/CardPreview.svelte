<script lang="ts" module>
	// One shared portal node for every CardPreview instance. The previous
	// implementation appended/removed a fresh div per hover, which churned
	// the DOM and left orphan nodes on route changes when Svelte tore
	// components down mid-animation.
	let sharedPortal: HTMLDivElement | null = null;
	let sharedImg: HTMLImageElement | null = null;
	let portalUsers = 0;

	function acquirePortal(): { root: HTMLDivElement; img: HTMLImageElement } {
		if (!sharedPortal) {
			sharedPortal = document.createElement('div');
			sharedPortal.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;border-radius:0.5rem;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);display:none;';
			sharedImg = document.createElement('img');
			sharedImg.style.cssText = 'width:100%;height:100%;';
			sharedPortal.appendChild(sharedImg);
			document.body.appendChild(sharedPortal);
		}
		portalUsers++;
		return { root: sharedPortal, img: sharedImg! };
	}

	function releasePortal() {
		portalUsers = Math.max(0, portalUsers - 1);
		if (portalUsers === 0 && sharedPortal) {
			sharedPortal.remove();
			sharedPortal = null;
			sharedImg = null;
		}
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		src,
		alt,
		scale = 2,
		maxWidth = 0,
		maxHeight = 0,
		contain = false,
		children
	}: {
		src: string;
		alt: string;
		scale?: number;
		maxWidth?: number;
		maxHeight?: number;
		contain?: boolean;
		children: Snippet;
	} = $props();

	let hovering = $state(false);
	let mouseX = $state(0);
	let mouseY = $state(0);
	let portal: { root: HTMLDivElement; img: HTMLImageElement } | null = null;

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

	// Acquire/release the shared portal only when hovering toggles, so a
	// mousemove burst doesn't churn the reference count.
	$effect(() => {
		if (!hovering || !src) return;
		portal = acquirePortal();
		const p = portal;
		return () => {
			if (p.root === sharedPortal) p.root.style.display = 'none';
			portal = null;
			releasePortal();
		};
	});

	// Reposition on every relevant change while we're holding the portal.
	$effect(() => {
		if (!hovering || !portal) return;
		const { root, img } = portal;

		const width = maxWidth || 244 * scale;
		const height = maxHeight || 340 * scale;
		let x = mouseX + 20;
		let y = mouseY - height / 2;
		if (x + width > window.innerWidth - 10) x = mouseX - width - 20;
		if (y < 10) y = 10;
		if (y + height > window.innerHeight - 10) y = window.innerHeight - height - 10;

		root.style.left = `${x}px`;
		root.style.top = `${y}px`;
		root.style.width = `${width}px`;
		root.style.height = `${height}px`;
		root.style.background = contain ? '#111' : '';
		root.style.display = 'block';
		img.style.objectFit = contain ? 'contain' : 'cover';
		if (img.src !== src) img.src = src;
		img.alt = alt;
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div onmouseenter={onEnter} onmouseleave={onLeave} onmousemove={onMove}>
	{@render children()}
</div>
