import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabase";

// Helper: build a Supabase client from request cookies for auth validation.
function getSupabaseFromRequest(req: NextRequest) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: () => {},
      },
    }
  );
}

// ─── GET: Fetch the authenticated user's listings ────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = getSupabaseFromRequest(req);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("listings_log")
    .select(
      "id, title, brand, model, condition, category, suggested_price, suggested_shipping_service, is_published, created_at"
    )
    .eq("seller_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[dashboard] Supabase query failed", error);
    return NextResponse.json(
      { error: "Failed to load listings" },
      { status: 500 }
    );
  }

  return NextResponse.json({ listings: data ?? [] });
}

// ─── PATCH: Toggle is_published for a listing owned by the authenticated user ─

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supabase = getSupabaseFromRequest(req);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let itemId: string;
  let publish: boolean;
  try {
    const body = (await req.json()) as {
      id?: unknown;
      is_published?: unknown;
    };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json(
        { error: "Missing listing id" },
        { status: 400 }
      );
    }
    if (typeof body.is_published !== "boolean") {
      return NextResponse.json(
        { error: "Missing is_published boolean" },
        { status: 400 }
      );
    }
    itemId = body.id;
    publish = body.is_published;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Only allow toggling items that belong to this seller
  const { data, error } = await supabaseAdmin
    .from("listings_log")
    .update({ is_published: publish })
    .eq("id", itemId)
    .eq("seller_id", user.id)
    .select("id, is_published")
    .single();

  if (error || !data) {
    console.error("[dashboard] Publish toggle failed", error);
    return NextResponse.json(
      { error: "Listing not found or not owned by you" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, is_published: data.is_published });
}

// ─── DELETE: Remove a specific listing owned by the authenticated user ───────

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supabase = getSupabaseFromRequest(req);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let listingId: string;
  try {
    const body = (await req.json()) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json(
        { error: "Missing listing id" },
        { status: 400 }
      );
    }
    listingId = body.id;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Delete only if the row belongs to this user — prevents cross-user deletion.
  const { error, count } = await supabaseAdmin
    .from("listings_log")
    .delete({ count: "exact" })
    .eq("id", listingId)
    .eq("seller_id", user.id);

  if (error) {
    console.error("[dashboard] Delete failed", error);
    return NextResponse.json(
      { error: "Failed to delete listing" },
      { status: 500 }
    );
  }

  if (count === 0) {
    return NextResponse.json(
      { error: "Listing not found or not owned by you" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
