create table if not exists public.mphone_forward_calls (
	event_id text primary key,
	extension_uuid uuid not null,
	extension text not null,
	caller_number text not null,
	dialed_number text not null,
	forward_destination text not null,
	status text not null default 'ringing',
	started_at timestamptz not null default now(),
	answered_at timestamptz,
	ended_at timestamptz,
	duration integer not null default 0,
	billsec integer not null default 0,
	hangup_cause text not null default '',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index if not exists mphone_forward_calls_extension_started_idx
	on public.mphone_forward_calls (extension_uuid, started_at desc);

revoke all on public.mphone_forward_calls from anon, authenticated;

create table if not exists public.mphone_forward_call_devices (
	event_id text not null references public.mphone_forward_calls(event_id) on delete cascade,
	device_id text not null,
	user_uuid uuid not null,
	extension_uuid uuid not null,
	created_at timestamptz not null default now(),
	deleted_at timestamptz,
	primary key (event_id, device_id)
);

create index if not exists mphone_forward_call_devices_user_device_idx
	on public.mphone_forward_call_devices (user_uuid, device_id, created_at desc);

revoke all on public.mphone_forward_call_devices from anon, authenticated;

insert into public.mphone_forward_call_devices (event_id, device_id, user_uuid, extension_uuid)
select calls.event_id, devices.device_id, devices.user_uuid, calls.extension_uuid
from public.mphone_forward_calls calls
join public.mphone_push_devices devices
	on devices.extension_uuid = calls.extension_uuid
	and devices.notifications_enabled = true
on conflict (event_id, device_id) do nothing;
