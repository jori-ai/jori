-- 0060 health: Apple Health samples, workouts, aggregates and clinical
-- records uploaded by the companion app, plus the RPCs agent/health-mcp and
-- the hum health harvester call.

create table if not exists public.health_samples (
  hk_uuid          uuid primary key,
  device_id        text not null,
  hk_type          text not null,
  start_date       timestamptz not null,
  end_date         timestamptz not null,
  value            double precision,
  unit             text,
  source_name      text,
  source_bundle_id text,
  metadata         jsonb,
  inserted_at      timestamptz not null default now()
);
create index if not exists health_samples_device_time_idx on public.health_samples (device_id, start_date desc);
create index if not exists health_samples_type_time_idx   on public.health_samples (hk_type, start_date desc);

create table if not exists public.health_workouts (
  hk_uuid           uuid primary key,
  device_id         text not null,
  activity_type     text not null,
  start_date        timestamptz not null,
  end_date          timestamptz not null,
  duration_s        double precision,
  total_energy_kcal double precision,
  total_distance_m  double precision,
  source_name       text,
  source_bundle_id  text,
  metadata          jsonb,
  inserted_at       timestamptz not null default now()
);
create index if not exists health_workouts_device_time_idx on public.health_workouts (device_id, start_date desc);
create index if not exists health_workouts_time_idx        on public.health_workouts (start_date desc);

create table if not exists public.health_aggregates (
  device_id    text not null,
  hk_type      text not null,
  granularity  text not null,
  bucket_start timestamptz not null,
  bucket_end   timestamptz not null,
  stat         text not null,
  value        double precision not null,
  unit         text,
  sample_count integer,
  updated_at   timestamptz not null default now(),
  primary key (device_id, hk_type, granularity, bucket_start, stat)
);
create index if not exists health_aggregates_type_bucket_idx on public.health_aggregates (hk_type, bucket_start desc);

create table if not exists public.health_clinical_records (
  hk_uuid            uuid primary key,
  device_id          text not null,
  hk_clinical_type   text not null,
  fhir_resource_type text,
  fhir_id            text,
  fhir_version       text,
  display_name       text,
  received_date      timestamptz,
  source_name        text,
  source_bundle_id   text,
  fhir_json          jsonb not null,
  inserted_at        timestamptz not null default now()
);
create index if not exists health_clinical_type_date_idx on public.health_clinical_records (hk_clinical_type, received_date desc);
create index if not exists health_clinical_resource_type_date_idx on public.health_clinical_records (fhir_resource_type, received_date desc)
  where fhir_resource_type is not null;
create index if not exists health_clinical_fhir_json_gin on public.health_clinical_records using gin (fhir_json);

create or replace function public.health_clinical_summary()
returns table (hk_clinical_type text, fhir_resource_type text, total_count bigint,
               earliest timestamptz, latest timestamptz)
language sql stable as $$
  select hk_clinical_type, fhir_resource_type, count(*)::bigint, min(received_date), max(received_date)
    from public.health_clinical_records
   group by 1, 2
   order by 1, 2;
$$;

create or replace function public.health_bucketed(
  p_type text, p_from timestamptz, p_to timestamptz,
  p_bucket text default 'day', p_agg text default 'avg'
)
returns table (bucket timestamptz, value double precision, n bigint)
language plpgsql stable as $$
begin
  if p_bucket = 'raw' then
    return query
      select hs.start_date as bucket, hs.value, 1::bigint as n
        from public.health_samples hs
       where hs.hk_type = p_type and hs.start_date >= p_from and hs.start_date < p_to
       order by hs.start_date
       limit 5000;
  else
    return query execute format($q$
      select date_trunc(%L, start_date) as bucket,
             case %L
               when 'sum'   then sum(value)
               when 'min'   then min(value)
               when 'max'   then max(value)
               when 'count' then count(*)::double precision
               else              avg(value)
             end as value,
             count(*)::bigint as n
        from public.health_samples
       where hk_type = %L and start_date >= %L and start_date < %L
       group by 1
       order by 1
    $q$, p_bucket, p_agg, p_type, p_from, p_to);
  end if;
end;
$$;

create or replace function public.health_types_summary()
returns table (hk_type text, sample_count bigint, first_date timestamptz, last_date timestamptz, units text[])
language plpgsql stable
set statement_timeout to '60s' as $$
declare t text;
begin
  for t in
    with recursive cte as (
      (select s.hk_type as ht from public.health_samples s order by s.hk_type limit 1)
      union all
      select (select s.hk_type from public.health_samples s where s.hk_type > c.ht order by s.hk_type limit 1)
        from cte c where c.ht is not null
    )
    select ht from cte where ht is not null
  loop
    hk_type := t;
    select count(*), min(s.start_date), max(s.start_date),
           array_agg(distinct s.unit) filter (where s.unit is not null)
      into sample_count, first_date, last_date, units
      from public.health_samples s where s.hk_type = t;
    return next;
  end loop;
end;
$$;

alter table public.health_samples          enable row level security;
alter table public.health_workouts         enable row level security;
alter table public.health_aggregates       enable row level security;
alter table public.health_clinical_records enable row level security;

-- The app uploads health data as the signed-in, allowlisted user.
do $$
declare t text;
begin
  foreach t in array array['health_samples','health_workouts','health_aggregates','health_clinical_records'] loop
    execute format('drop policy if exists %I on public.%I', t || '_allowed_all', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user())', t || '_allowed_all', t);
  end loop;
end $$;
