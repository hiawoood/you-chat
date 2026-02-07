import { useState, useEffect, useRef, type RefObject } from "react";

/**
 * Tracks scroll direction on a scrollable element.
 * Returns "up" | "down" | null (null = no scroll yet).
 * Only triggers after `threshold` px of consistent scroll.
 * Shows header when near the bottom (within `bottomMargin` px).
 */
export function useScrollDirection(
  ref: RefObject<HTMLElement | null>,
  threshold = 10,
  bottomMargin = 50
): "up" | "down" | null {
  const [direction, setDirection] = useState<"up" | "down" | null>(null);
  const lastScrollTop = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleScroll = () => {
      const scrollTop = el.scrollTop;
      const delta = scrollTop - lastScrollTop.current;

      // If near the bottom, always show header (direction = "up")
      const distanceFromBottom = el.scrollHeight - el.clientHeight - scrollTop;
      if (distanceFromBottom < bottomMargin) {
        if (direction === "down") setDirection("up");
        lastScrollTop.current = scrollTop;
        return;
      }

      if (Math.abs(delta) >= threshold) {
        setDirection(delta > 0 ? "down" : "up");
        lastScrollTop.current = scrollTop;
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [ref, threshold, bottomMargin, direction]);

  return direction;
}
