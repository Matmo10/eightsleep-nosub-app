"use client";
import React, { useState, useEffect } from "react";
import { useForm, useFieldArray, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiR } from "~/trpc/react";
import TimezoneSelect, { allTimezones } from "react-timezone-select";
import { Button } from "./ui/button";

// --- Zod Schemas ---

const settingsSchema = z.object({
  preheatOnly: z.boolean(),
  preheatTime: z.string().regex(/^\d{2}:\d{2}$/, "Must be in HH:MM format"),
  preheatLevel: z.number().min(-10).max(10),
  timezone: z.object({
    value: z.string(),
    altName: z.string().optional(),
    abbrev: z.string().optional(),
  }),
});

type SettingsForm = z.infer<typeof settingsSchema>;

const profileSchema = z.object({
  name: z.string().min(1, "Profile name is required").max(100),
  phases: z.array(z.object({
    time: z.string().regex(/^\d{2}:\d{2}$/, "Must be in HH:MM format"),
    level: z.number().min(-10).max(10),
    isOff: z.boolean(),
  })).min(1, "At least one phase is required"),
});

type ProfileForm = z.infer<typeof profileSchema>;

// --- Main Component ---

export const TemperatureProfileForm: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isExistingProfile, setIsExistingProfile] = useState(false);
  const [scheduleMode, setScheduleMode] = useState(false); // false = preheat-only, true = schedule
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<number | null>(null);
  const initializedRef = React.useRef(false);

  // --- Queries ---
  const settingsQuery = apiR.user.getUserTemperatureProfile.useQuery();
  const profilesQuery = apiR.user.getSleepProfiles.useQuery();

  // --- Mutations ---
  const updateSettingsMutation = apiR.user.updateUserTemperatureProfile.useMutation({
    onSuccess: () => {
      console.log("Settings updated successfully");
      setIsExistingProfile(true);
    },
  });

  const deleteSettingsMutation = apiR.user.deleteUserTemperatureProfile.useMutation({
    onSuccess: () => {
      console.log("Settings deleted successfully");
      setIsExistingProfile(false);
      settingsForm.reset();
    },
  });

  const createProfileMutation = apiR.user.createSleepProfile.useMutation({
    onSuccess: (newProfile) => {
      void profilesQuery.refetch();
      setSelectedProfileId(newProfile.id);
      setEditingProfileId(newProfile.id);
    },
  });

  const updateProfileMutation = apiR.user.updateSleepProfile.useMutation({
    onSuccess: () => void profilesQuery.refetch(),
  });

  const deleteProfileMutation = apiR.user.deleteSleepProfile.useMutation({
    onSuccess: () => {
      void profilesQuery.refetch();
      if (editingProfileId === selectedProfileId) {
        setSelectedProfileId(null);
      }
      setEditingProfileId(null);
    },
  });

  const setActiveProfileMutation = apiR.user.setActiveProfile.useMutation({
    onSuccess: () => void settingsQuery.refetch(),
  });

  // --- Settings Form ---
  const settingsForm = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      preheatOnly: true,
      preheatTime: "21:00",
      preheatLevel: 3,
      timezone: { value: "America/New_York" },
    },
  });

  // --- Profile Editor Form ---
  const profileForm = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: "",
      phases: [{ time: "22:00", level: 2, isOff: false }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: profileForm.control,
    name: "phases",
  });

  // --- Load existing data (only on initial load) ---
  useEffect(() => {
    if (initializedRef.current) return;
    if (settingsQuery.isSuccess) {
      const data = settingsQuery.data;
      settingsForm.setValue("preheatOnly", data.preheatOnly);
      settingsForm.setValue("preheatTime", data.preheatTime.slice(0, 5));
      settingsForm.setValue("preheatLevel", data.preheatLevel);
      settingsForm.setValue("timezone", { value: data.timezoneTZ });

      const hasActiveProfile = data.activeProfileId !== null && data.activeProfileId !== undefined;
      setScheduleMode(!data.preheatOnly && hasActiveProfile);
      setSelectedProfileId(data.activeProfileId ?? null);
      setIsExistingProfile(true);
      setIsLoading(false);
      initializedRef.current = true;
    } else if (settingsQuery.isError) {
      setIsExistingProfile(false);
      setIsLoading(false);
      initializedRef.current = true;
    }
  }, [settingsQuery.isSuccess, settingsQuery.isError, settingsQuery.data, settingsForm]);

  // --- Load profile into editor when selected ---
  useEffect(() => {
    if (editingProfileId && profilesQuery.data) {
      const profile = profilesQuery.data.find(p => p.id === editingProfileId);
      if (profile) {
        const phases = (profile.phases as Array<{ time: string; level: number | null }>);
        profileForm.reset({
          name: profile.name,
          phases: phases.map(p => ({
            time: p.time,
            level: p.level !== null ? p.level / 10 : 0,
            isOff: p.level === null,
          })),
        });
      }
    }
  }, [editingProfileId, profilesQuery.data, profileForm]);

  // --- Auto-open editor when selecting a profile ---
  useEffect(() => {
    if (selectedProfileId && !editingProfileId) {
      setEditingProfileId(selectedProfileId);
    }
  }, [selectedProfileId, editingProfileId]);

  // --- Handlers ---
  const onSaveSettings = (data: SettingsForm) => {
    updateSettingsMutation.mutate({
      timezoneTZ: data.timezone.value,
      preheatTime: `${data.preheatTime}:00.000000`,
      preheatLevel: data.preheatLevel,
      preheatOnly: !scheduleMode,
      activeProfileId: scheduleMode ? selectedProfileId : null,
    });
  };

  const onSaveProfile = (data: ProfileForm) => {
    const phases = data.phases.map(p => ({
      time: p.time,
      level: p.isOff ? null : Math.round(p.level * 10),
    }));

    if (editingProfileId) {
      updateProfileMutation.mutate({ id: editingProfileId, name: data.name, phases });
    } else {
      createProfileMutation.mutate({ name: data.name, phases });
    }
  };

  const onDeleteProfile = () => {
    if (editingProfileId && window.confirm("Delete this profile?")) {
      deleteProfileMutation.mutate({ id: editingProfileId });
    }
  };

  const onCreateNewProfile = () => {
    profileForm.reset({
      name: "New Profile",
      phases: [
        { time: "22:00", level: 2, isOff: false },
        { time: "07:00", level: 0, isOff: true },
      ],
    });
    setEditingProfileId(null);
    // Save immediately so it gets an ID
    createProfileMutation.mutate({
      name: "New Profile",
      phases: [
        { time: "22:00", level: 20 },
        { time: "07:00", level: null },
      ],
    });
  };

  const onSelectProfile = (profileId: number) => {
    setSelectedProfileId(profileId);
    setEditingProfileId(profileId);
    setActiveProfileMutation.mutate({ profileId });
  };

  const onDeleteSettings = () => {
    if (window.confirm("Are you sure you want to delete your temperature profile?")) {
      deleteSettingsMutation.mutate();
    }
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="mx-auto mt-8 max-w-md space-y-6">
      {/* --- Settings Card --- */}
      <div className="rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-center text-2xl font-bold text-gray-800">
          Temperature Settings
        </h2>
        <form onSubmit={settingsForm.handleSubmit(onSaveSettings)} className="space-y-4 text-gray-800">
          {/* Mode Toggle */}
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={!scheduleMode}
                onChange={() => setScheduleMode(false)}
                className="text-indigo-600"
              />
              <span className="text-sm font-medium">Preheat Only</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={scheduleMode}
                onChange={() => setScheduleMode(true)}
                className="text-indigo-600"
              />
              <span className="text-sm font-medium">Schedule Mode</span>
            </label>
          </div>

          {/* Timezone (always visible) */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Timezone</label>
            <Controller
              name="timezone"
              control={settingsForm.control}
              render={({ field }) => (
                <TimezoneSelect
                  value={field.value}
                  onChange={field.onChange}
                  timezones={{
                    ...allTimezones,
                    "America/New_York": "America/New York",
                    "America/Los_Angeles": "America/Los Angeles",
                  }}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                />
              )}
            />
          </div>

          {/* Preheat-Only Settings */}
          {!scheduleMode && (
            <div className="space-y-4 rounded-md bg-gray-50 p-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Pre-heat Time</label>
                <input
                  {...settingsForm.register("preheatTime")}
                  type="time"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Pre-heat Level</label>
                <Controller
                  name="preheatLevel"
                  control={settingsForm.control}
                  render={({ field: { onChange, value } }) => (
                    <div className="flex items-center">
                      <input
                        type="range" min="-10" max="10" step="1"
                        value={value} onChange={(e) => onChange(Number(e.target.value))}
                        className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200"
                      />
                      <span className="ml-2 w-8 text-sm text-gray-600">{value}</span>
                    </div>
                  )}
                />
              </div>
            </div>
          )}

          {/* Schedule Mode: Profile Selector */}
          {scheduleMode && (
            <div className="space-y-3 rounded-md bg-gray-50 p-4">
              <label className="block text-sm font-medium text-gray-700">Active Profile</label>
              <div className="flex gap-2">
                <select
                  value={selectedProfileId ?? ""}
                  onChange={(e) => {
                    const id = e.target.value ? Number(e.target.value) : null;
                    if (id) onSelectProfile(id);
                  }}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
                >
                  <option value="">Select a profile...</option>
                  {profilesQuery.data?.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <Button
                  type="button"
                  onClick={onCreateNewProfile}
                  className="whitespace-nowrap bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700"
                  disabled={createProfileMutation.isPending}
                >
                  + New
                </Button>
              </div>
            </div>
          )}

          {/* Save / Delete Settings */}
          <div className="flex justify-between pt-2">
            <Button
              type="submit"
              className="flex-grow bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              disabled={updateSettingsMutation.isPending}
            >
              {updateSettingsMutation.isPending ? "Saving..." : (isExistingProfile ? "Update" : "Create") + " Settings"}
            </Button>
            {isExistingProfile && (
              <Button
                type="button"
                onClick={onDeleteSettings}
                className="ml-4 bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
                disabled={deleteSettingsMutation.isPending}
              >
                Delete All
              </Button>
            )}
          </div>

          {updateSettingsMutation.isError && (
            <p className="text-center text-sm text-red-600">
              Error saving settings: {updateSettingsMutation.error.message}
            </p>
          )}
        </form>
      </div>

      {/* --- Profile Editor Card --- */}
      {scheduleMode && editingProfileId !== null && (
        <div className="rounded-lg bg-white p-6 shadow-xl">
          <h2 className="mb-4 text-center text-xl font-bold text-gray-800">
            Edit Profile
          </h2>
          <form onSubmit={profileForm.handleSubmit(onSaveProfile)} className="space-y-4 text-gray-800">
            {/* Profile Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700">Profile Name</label>
              <input
                {...profileForm.register("name")}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
              />
              {profileForm.formState.errors.name && (
                <p className="mt-1 text-sm text-red-600">{profileForm.formState.errors.name.message}</p>
              )}
            </div>

            {/* Phases */}
            <div className="space-y-3">
              <label className="block text-sm font-medium text-gray-700">Phases</label>
              {fields.map((field, index) => {
                const isOff = profileForm.watch(`phases.${index}.isOff`);
                return (
                  <div key={field.id} className="flex items-center gap-2 rounded-md bg-gray-50 p-3">
                    <span className="text-xs font-medium text-gray-400 w-4">{index + 1}</span>
                    {/* Time */}
                    <input
                      {...profileForm.register(`phases.${index}.time`)}
                      type="time"
                      className="w-28 rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
                    />
                    {/* Off toggle */}
                    <label className="flex items-center gap-1 text-xs whitespace-nowrap">
                      <Controller
                        name={`phases.${index}.isOff`}
                        control={profileForm.control}
                        render={({ field: { onChange, value } }) => (
                          <input type="checkbox" checked={value} onChange={onChange} className="rounded" />
                        )}
                      />
                      Off
                    </label>
                    {/* Level slider (hidden if off) */}
                    {!isOff && (
                      <Controller
                        name={`phases.${index}.level`}
                        control={profileForm.control}
                        render={({ field: { onChange, value } }) => (
                          <div className="flex flex-1 items-center gap-1">
                            <input
                              type="range" min="-10" max="10" step="1"
                              value={value} onChange={(e) => onChange(Number(e.target.value))}
                              className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200"
                            />
                            <span className="w-6 text-center text-xs text-gray-600">{value}</span>
                          </div>
                        )}
                      />
                    )}
                    {isOff && <span className="flex-1 text-xs text-gray-400 italic">Turn off bed</span>}
                    {/* Remove button */}
                    {fields.length > 1 && (
                      <button
                        type="button"
                        onClick={() => remove(index)}
                        className="text-red-400 hover:text-red-600 text-sm font-bold"
                      >
                        &times;
                      </button>
                    )}
                  </div>
                );
              })}
              <Button
                type="button"
                onClick={() => append({ time: "23:00", level: 0, isOff: false })}
                className="w-full bg-gray-100 py-1 text-sm text-gray-600 hover:bg-gray-200"
              >
                + Add Phase
              </Button>
            </div>

            {/* Save / Delete Profile */}
            <div className="flex justify-between pt-2">
              <Button
                type="submit"
                className="flex-grow bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                disabled={updateProfileMutation.isPending}
              >
                {updateProfileMutation.isPending ? "Saving..." : "Save Profile"}
              </Button>
              <Button
                type="button"
                onClick={onDeleteProfile}
                className="ml-4 bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
                disabled={deleteProfileMutation.isPending}
              >
                Delete Profile
              </Button>
            </div>

            {updateProfileMutation.isError && (
              <p className="text-center text-sm text-red-600">
                Error saving profile: {updateProfileMutation.error.message}
              </p>
            )}
            {updateProfileMutation.isSuccess && (
              <p className="text-center text-sm text-green-600">Profile saved!</p>
            )}
          </form>
        </div>
      )}

      {/* New profile creation (no profile selected yet) */}
      {scheduleMode && editingProfileId === null && !profilesQuery.data?.length && (
        <div className="rounded-lg bg-white p-6 shadow-xl text-center">
          <p className="text-gray-600 mb-4">No profiles yet. Create one to get started.</p>
          <Button
            onClick={onCreateNewProfile}
            className="bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            disabled={createProfileMutation.isPending}
          >
            Create First Profile
          </Button>
        </div>
      )}
    </div>
  );
};
