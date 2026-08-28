import { redirect } from 'next/navigation';

/**
 * The bare `routePrefix` page redirects to Check-ins, not Trips, for now.
 * SPEC.md's Routes section documents the eventual home as Trips (the real
 * browse/manage/share hub once `T.13` ships it) — correct for the finished
 * product, but landing a fresh user on Trips' "coming soon" placeholder
 * today directly undercuts CONCEPT.md's own Slice 1 framing ("ships
 * standalone and useful... check-in ships first because it's the daily-use
 * half"). Found live during `T.9`'s audit. Move this back to
 * `/travellog/trips` once `T.13` ships Trips for real — SPEC.md's Routes
 * section notes this as the intended final state.
 */
export default function TravellogRootPage() {
  redirect('/travellog/checkins');
}
