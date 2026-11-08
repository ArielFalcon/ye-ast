package shop;
import jakarta.persistence.EntityManager;
class Order {}
class Jpa {
 private EntityManager em;
 void run(Order o) {
 em.createQuery("select o from Order o");
 em.find(Order.class, 1L);
 em.persist(o);
 o.getName();
 em.createQuery("select o from Order o").getResultList();
 }
}
