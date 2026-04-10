#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, String,
    Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
pub struct Resource {
    pub owner: Address,
    pub name: String,
    pub resource_type: Symbol,
    pub capacity: u32,
    pub location: String,
    pub reserved_by: Address,
    pub has_reservation: bool,
    pub reserved_start: u64,
    pub reserved_end: u64,
    pub is_available: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum ResourceDataKey {
    IdList,
    Resource(Symbol),
    Count,
}

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ResourceError {
    InvalidName = 1,
    NotFound = 2,
    AlreadyExists = 3,
    NotAvailable = 4,
    Unauthorized = 5,
    NoReservation = 6,
    InvalidTimeRange = 7,
}

#[contract]
pub struct ResourceAvailabilityContract;

#[contractimpl]
impl ResourceAvailabilityContract {
    fn resource_key(id: &Symbol) -> ResourceDataKey {
        ResourceDataKey::Resource(id.clone())
    }

    fn has_id(ids: &Vec<Symbol>, id: &Symbol) -> bool {
        for current in ids.iter() {
            if current == id.clone() {
                return true;
            }
        }
        false
    }

    fn load_ids(env: &Env) -> Vec<Symbol> {
        env.storage().instance().get(&ResourceDataKey::IdList).unwrap_or(Vec::new(env))
    }

    fn save_ids(env: &Env, ids: &Vec<Symbol>) {
        env.storage().instance().set(&ResourceDataKey::IdList, ids);
    }

    pub fn register_resource(
        env: Env,
        id: Symbol,
        owner: Address,
        name: String,
        resource_type: Symbol,
        capacity: u32,
        location: String,
    ) {
        owner.require_auth();

        if name.len() == 0 {
            panic_with_error!(&env, ResourceError::InvalidName);
        }

        let key = Self::resource_key(&id);
        if env.storage().instance().has(&key) {
            panic_with_error!(&env, ResourceError::AlreadyExists);
        }

        let resource = Resource {
            owner: owner.clone(),
            name,
            resource_type,
            capacity,
            location,
            reserved_by: owner,
            has_reservation: false,
            reserved_start: 0,
            reserved_end: 0,
            is_available: true,
        };

        env.storage().instance().set(&key, &resource);

        let mut ids = Self::load_ids(&env);
        ids.push_back(id);
        Self::save_ids(&env, &ids);

        let count: u32 = env.storage().instance().get(&ResourceDataKey::Count).unwrap_or(0);
        env.storage().instance().set(&ResourceDataKey::Count, &(count + 1));
    }

    pub fn reserve_resource(
        env: Env,
        id: Symbol,
        reserver: Address,
        start_time: u64,
        end_time: u64,
    ) {
        reserver.require_auth();

        if start_time >= end_time {
            panic_with_error!(&env, ResourceError::InvalidTimeRange);
        }

        let key = Self::resource_key(&id);
        let maybe: Option<Resource> = env.storage().instance().get(&key);

        if let Some(mut resource) = maybe {
            if !resource.is_available {
                panic_with_error!(&env, ResourceError::NotAvailable);
            }

            resource.reserved_by = reserver;
            resource.has_reservation = true;
            resource.reserved_start = start_time;
            resource.reserved_end = end_time;
            resource.is_available = false;

            env.storage().instance().set(&key, &resource);
        } else {
            panic_with_error!(&env, ResourceError::NotFound);
        }
    }

    pub fn release_resource(env: Env, id: Symbol, reserver: Address) {
        reserver.require_auth();

        let key = Self::resource_key(&id);
        let maybe: Option<Resource> = env.storage().instance().get(&key);

        if let Some(mut resource) = maybe {
            if !resource.has_reservation {
                panic_with_error!(&env, ResourceError::NoReservation);
            }
            if resource.reserved_by != reserver {
                panic_with_error!(&env, ResourceError::Unauthorized);
            }

            resource.has_reservation = false;
            resource.reserved_start = 0;
            resource.reserved_end = 0;
            resource.is_available = true;

            env.storage().instance().set(&key, &resource);
        } else {
            panic_with_error!(&env, ResourceError::NotFound);
        }
    }

    pub fn check_availability(env: Env, id: Symbol) -> bool {
        let key = Self::resource_key(&id);
        let maybe: Option<Resource> = env.storage().instance().get(&key);

        if let Some(resource) = maybe {
            resource.is_available
        } else {
            false
        }
    }

    pub fn get_resource(env: Env, id: Symbol) -> Option<Resource> {
        env.storage().instance().get(&Self::resource_key(&id))
    }

    pub fn list_resources(env: Env) -> Vec<Symbol> {
        Self::load_ids(&env)
    }

    pub fn get_count(env: Env) -> u32 {
        env.storage().instance().get(&ResourceDataKey::Count).unwrap_or(0)
    }
}