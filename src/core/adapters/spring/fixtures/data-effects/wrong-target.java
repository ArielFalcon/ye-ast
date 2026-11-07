import jakarta.persistence.EntityManager;
class Order {}
class WrongTarget { void run(EntityManager em) { class Order {} em.find(Order.class,1L); } }