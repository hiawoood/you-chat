import { useState, useEffect, useRef, type RefObject } from "react";

/**
 * Tracks scroll direction on a scrollable element.
 * Returns "up" | "down" | null (null = no scroll yet).
 * Only triggers after `threshold` px of consistent scroll.
 */
export function useScrollDirection(
  ref: RefObject<HTMLElement | null>,
  threshold = 10
): "up" | "down" | null {
  const [direction, setDirection] = useState<"up" | "down" | null>(null);
  const lastScrollTop = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleScroll = () => {
      const scrollTop = el.scrollTop;
      const delta = scrollTop - lastScrollTop.current;

      if (Math.abs(delta) >= threshold) {
        setDirection(delta > 0 ? "down" : "up");
        lastScrollTop.current = scrollTop;
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [ref, threshold]);

  return direction;
}
