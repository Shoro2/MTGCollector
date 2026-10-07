<script lang="ts" module>
	// Share one body portal, including its dismiss control, across all thumbnails.
	type Portal = { root: HTMLDivElement; img: HTMLImageElement; close: HTMLButtonElement; backdrop: HTMLDivElement; owner: symbol };
	let shared: Omit<Portal, 'owner'> | null = null;
	let currentOwner: symbol | null = null;
	let dismissOwner: (() => void) | null = null;
	let portalUsers = 0;

	function acquirePortal(dismiss: () => void): Portal {
		dismissOwner?.();
		if (!shared) {
			const backdrop = document.createElement('div');
			backdrop.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.55);display:none;touch-action:none;';
			const root = document.createElement('div');
			root.dataset.cardPreview = '';
			root.style.cssText = 'position:fixed;z-index:9999;border-radius:0.5rem;box-shadow:0 25px 50px -12px rgba(0,0,0,.5);display:none;';
			const img = document.createElement('img');
			img.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;border-radius:0.5rem;';
			const close = document.createElement('button');
			close.type = 'button'; close.textContent = '×';
			close.setAttribute('aria-label', 'Close preview');
			close.style.cssText = 'position:absolute;top:6px;right:6px;width:36px;height:36px;border:1px solid rgba(255,255,255,.6);border-radius:50%;background:rgba(0,0,0,.8);color:white;font:28px/1 sans-serif;cursor:pointer;display:none;';
			root.append(img, close);
			document.body.append(backdrop, root);
			shared = { root, img, close, backdrop };
		}
		portalUsers++;
		currentOwner = Symbol('card-preview'); dismissOwner = dismiss;
		return { ...shared, owner: currentOwner };
	}
	function releasePortal(p: Portal) {
		if (currentOwner === p.owner) {
			p.root.style.display = 'none'; p.backdrop.style.display = 'none';
			currentOwner = null; dismissOwner = null;
		}
		portalUsers = Math.max(0, portalUsers - 1);
		if (portalUsers === 0 && shared) { shared.root.remove(); shared.backdrop.remove(); shared = null; }
	}
</script>

<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	let { src, alt, scale = 2, maxWidth = 0, maxHeight = 0, contain = false, children }: {
		src: string; alt: string; scale?: number; maxWidth?: number; maxHeight?: number; contain?: boolean; children: Snippet;
	} = $props();
	let hovering = $state(false);
	let pinned = $state(false);
	let mouseX = $state(0);
	let mouseY = $state(0);
	let portal = $state.raw<Portal | null>(null);
	let viewport = $state({ width: 0, height: 0, left: 0, top: 0 });
	let previousFocus: Element | null = null;
	let lastPointerType = 'mouse';

	onMount(() => {
		const update = () => {
			const v = window.visualViewport;
			viewport = { width: v?.width ?? window.innerWidth, height: v?.height ?? window.innerHeight, left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0 };
		};
		update();
		window.addEventListener('resize', update);
		window.visualViewport?.addEventListener('resize', update);
		window.visualViewport?.addEventListener('scroll', update);
		return () => {
			window.removeEventListener('resize', update);
			window.visualViewport?.removeEventListener('resize', update);
			window.visualViewport?.removeEventListener('scroll', update);
		};
	});
	function dismiss() {
		hovering = false; pinned = false;
		if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
		previousFocus = null;
	}
	function onEnter(e: PointerEvent) {
		if (e.pointerType !== 'mouse' || pinned) return;
		mouseX = e.clientX; mouseY = e.clientY; hovering = true;
	}
	function onLeave() { if (!pinned) hovering = false; }
	function onMove(e: PointerEvent) {
		if (e.pointerType !== 'mouse' || pinned) return;
		mouseX = e.clientX; mouseY = e.clientY;
	}
	function onPress(e: PointerEvent) {
		lastPointerType = e.pointerType;
	}
	function onClick(e: MouseEvent) {
		// Open after a completed tap, so starting a scroll on a thumbnail does not open a dialog.
		if (lastPointerType !== 'mouse') {
			e.preventDefault(); e.stopPropagation(); previousFocus = e.currentTarget as HTMLElement;
			hovering = false; pinned = true;
		} else if (pinned) e.stopPropagation();
	}
	function onKey(e: KeyboardEvent) {
		if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
		e.preventDefault(); e.stopPropagation(); previousFocus = document.activeElement; pinned = true;
	}
	$effect(() => {
		if ((!hovering && !pinned) || !src) return;
		const p = acquirePortal(dismiss); portal = p;
		p.close.addEventListener('click', dismiss);
		const onDialogKey = (e: KeyboardEvent) => {
			if (!pinned || currentOwner !== p.owner) return;
			if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
			if (e.key === 'Tab') { e.preventDefault(); p.close.focus(); }
		};
		window.addEventListener('keydown', onDialogKey);
		return () => {
			p.close.removeEventListener('click', dismiss); window.removeEventListener('keydown', onDialogKey);
			releasePortal(p); portal = null;
		};
	});
	$effect(() => {
		if ((!hovering && !pinned) || !portal || currentOwner !== portal.owner || viewport.width === 0) return;
		const { root, img, close, backdrop } = portal;
		const desiredWidth = maxWidth || 244 * scale, desiredHeight = maxHeight || 340 * scale;
		const margin = 16;
		const fit = Math.min(1, Math.max(1, viewport.width - 2 * margin) / desiredWidth, Math.max(1, viewport.height - 2 * margin) / desiredHeight);
		const width = desiredWidth * fit, height = desiredHeight * fit;
		const left = viewport.left + margin, top = viewport.top + margin;
		let x = mouseX + 20, y = mouseY - height / 2;
		if (pinned) { x = viewport.left + (viewport.width - width) / 2; y = viewport.top + (viewport.height - height) / 2; }
		else {
			if (x + width > viewport.left + viewport.width - margin) x = mouseX - width - 20;
			x = Math.max(left, Math.min(x, viewport.left + viewport.width - width - margin));
			y = Math.max(top, Math.min(y, viewport.top + viewport.height - height - margin));
		}
		root.style.left = x + 'px'; root.style.top = y + 'px';
		root.style.width = width + 'px'; root.style.height = height + 'px';
		root.style.background = contain ? '#111' : '';
		root.style.pointerEvents = pinned ? 'auto' : 'none'; root.style.touchAction = pinned ? 'none' : '';
		root.style.display = 'block'; root.setAttribute('role', pinned ? 'dialog' : 'img');
		if (pinned) { root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', alt); }
		else { root.removeAttribute('aria-modal'); root.removeAttribute('aria-label'); }
		backdrop.style.display = pinned ? 'block' : 'none'; close.style.display = pinned ? 'block' : 'none';
		if (img.getAttribute('src') !== src) img.src = src;
		img.alt = alt;
		if (pinned) close.focus({ preventScroll: true });
	});
</script>

<div role="button" tabindex="0" aria-label="Preview {alt}" onpointerenter={onEnter} onpointerleave={onLeave} onpointermove={onMove} onpointerdown={onPress} onpointercancel={() => lastPointerType = 'mouse'} onkeydown={onKey} onclick={onClick}>
	{@render children()}
</div>
