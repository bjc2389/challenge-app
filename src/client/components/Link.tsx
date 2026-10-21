import type { ComponentChildren } from "preact";
import { navigate } from "../router";

// An in-app link: a plain click navigates without a reload; modified clicks
// (new tab, new window) behave like a normal link.
export function Link({ href, children, class: className }: { href: string; children: ComponentChildren; class?: string }) {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} class={className} onClick={onClick}>
      {children}
    </a>
  );
}
