create table if not exists public.mphone_push_devices (
	push_device_uuid uuid primary key default gen_random_uuid(),
	user_uuid uuid not null,
	extension_uuid uuid not null,
	device_id text not null,
	fcm_token text not null,
	notifications_enabled boolean not null default true,
	locale text not null default 'vi',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (extension_uuid, device_id)
);

create index if not exists mphone_push_devices_extension_enabled_idx
	on public.mphone_push_devices (extension_uuid, notifications_enabled);

create index if not exists mphone_push_devices_fcm_token_idx
	on public.mphone_push_devices (fcm_token);

revoke all on public.mphone_push_devices from anon, authenticated;

